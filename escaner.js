// Escáner de códigos: cámara en vivo y, como alternativa, escribir el código o usar un lector
// USB/Bluetooth (funciona como un teclado: escribe y pulsa Intro).
//
// Motor de lectura: el BarcodeDetector nativo del navegador (Android/Chrome, muy rápido) y, donde no
// existe o no lee Code 128 (iPhone, Windows), ZXing-C++ en WebAssembly (barcode-detector). Se pide a la
// cámara alta resolución y enfoque continuo, y se analiza a resolución completa la franja que se ve en
// pantalla: las etiquetas son de 50 × 10 mm y con poca resolución las barras se funden.

const MOTOR_ZXING = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.1/dist/iife/ponyfill.js';
const FORMATOS = ['code_128', 'qr_code', 'code_39', 'ean_13', 'ean_8'];

const Escaner = {
  activo: null,   // { flujo, video, pista, detector, motor, temporizador }
  ultimo: '',
  ultimoT: 0,
  alLeer: null,
  encendiendo: false,
  pendiente: false,
  zoom: 1,

  // Marcado del escáner. Tras pintarlo hay que llamar a Escaner.montar(alLeer).
  html(pista) {
    return `<div class="camara" id="camara"><div class="camara-off"><button class="btn" onclick="Escaner.encender()">Activar cámara</button><div class="small" style="color:#fff;margin-top:8px">${esc(pista)}</div></div></div>
      <form class="row" onsubmit="event.preventDefault();Escaner.manual()">
        <input class="input" id="codigoManual" placeholder="O escribe el código / usa el lector" autocomplete="off" autocapitalize="characters">
        <button class="btn ghost" type="submit">Añadir</button>
      </form>`;
  },

  montar(alLeer) {
    this.alLeer = alLeer;
    try { if (localStorage.getItem('camara') === 'si') this.encender(); } catch (e) { /* sin almacenamiento */ }
  },

  async encender() {
    const caja = document.getElementById('camara');
    // Una cámara cuyo vídeo ya no está en la página es huérfana: se apaga antes de abrir otra
    if (this.activo && !document.body.contains(this.activo.video)) this.apagar(false);
    if (this.encendiendo) { this.pendiente = true; return; } // se repetirá al acabar el encendido en curso
    if (this.activo || !caja) return;
    this.encendiendo = true;
    caja.innerHTML = '<div class="camara-off"><div class="small" style="color:#fff">Iniciando cámara…</div></div>';
    let flujo;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('este navegador no permite usar la cámara (¿la página no es https?)');
      const motor = prepararDetector(); // se carga a la vez que se abre la cámara
      flujo = await conLimite(navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      }), 10000, 'la cámara no responde. Ciérrala en otras aplicaciones o pestañas y reintenta');
      if (!document.body.contains(caja)) { detener(flujo); return; } // se cambió de pantalla mientras tanto
      const pista = flujo.getVideoTracks()[0];
      await ajustarCamara(pista);
      caja.innerHTML = `<video id="camaraVideo" playsinline muted autoplay></video><div class="camara-marco" id="camaraMarco"></div>
        <div class="camara-botones"><button class="btn ghost sm" id="camaraLuz" hidden onclick="Escaner.luz()">Linterna</button><button class="btn ghost sm" id="camaraZoom" hidden onclick="Escaner.cambiarZoom()">Zoom ×1</button><button class="btn ghost sm" onclick="Escaner.apagar()">Parar</button></div>
        <div class="camara-info" id="camaraInfo"></div>`;
      const video = caja.querySelector('video');
      video.srcObject = flujo;
      await conLimite(video.play(), 5000, 'el vídeo de la cámara no arranca');
      const { detector, nombre } = await conLimite(motor, 20000, 'no se ha podido cargar el lector de códigos. Revisa la conexión');
      if (!document.body.contains(video)) { detener(flujo); return; }
      this.activo = { flujo, video, pista, detector, motor: nombre, temporizador: 0 };
      this.mostrarControles();
      try { localStorage.setItem('camara', 'si'); } catch (e) { /* sin almacenamiento */ }
      this.analizar();
    } catch (e) {
      if (flujo && !this.activo) detener(flujo);
      if (document.body.contains(caja)) caja.innerHTML = `<div class="camara-off"><div class="small" style="color:#fff">No se puede usar la cámara: ${esc(mensajeCamara(e))}</div><button class="btn ghost sm" style="margin-top:8px" onclick="Escaner.encender()">Reintentar</button></div>`;
    } finally {
      this.encendiendo = false;
      if (this.pendiente) { this.pendiente = false; if (!this.activo && document.getElementById('camara')) this.encender(); }
    }
  },

  // Bucle de lectura: un fotograma cada vez, sin solapar análisis.
  async analizar() {
    const a = this.activo;
    if (!a || this.activo !== a) return;
    if (!document.body.contains(a.video)) { this.apagar(false); return; }
    let espera = 80;
    if (!document.hidden && a.video.readyState >= 2 && a.video.videoWidth) {
      try {
        // ZXing solo lee códigos de barras casi horizontales: si no lee, prueba también con el fotograma girado
        const giro = a.motor === 'ZXing' ? GIROS[(a.vuelta = (a.vuelta || 0) + 1) % GIROS.length] : 0;
        const lienzo = recorteVisible(a.video, giro);
        const codigos = await a.detector.detect(lienzo);
        const bueno = codigos.find(c => c.rawValue && c.rawValue.trim());
        if (bueno && this.activo === a) { this.leido(bueno.rawValue); espera = 400; }
      } catch (e) { espera = 300; /* un fotograma que no se pudo leer: se sigue con el siguiente */ }
    } else espera = 200;
    if (this.activo === a) a.temporizador = setTimeout(() => this.analizar(), espera);
  },

  mostrarControles() {
    const a = this.activo; if (!a) return;
    const cap = capacidades(a.pista), ajustes = a.pista.getSettings ? a.pista.getSettings() : {};
    const luz = document.getElementById('camaraLuz'), zoom = document.getElementById('camaraZoom');
    if (luz) luz.hidden = !cap.torch;
    if (zoom && cap.zoom && cap.zoom.max >= 2) { zoom.hidden = false; zoom.textContent = 'Zoom ×' + (this.zoom > 1 ? 1 : 2); }
    const info = document.getElementById('camaraInfo');
    if (info) info.textContent = (ajustes.width || a.video.videoWidth) + '×' + (ajustes.height || a.video.videoHeight) + ' · ' + a.motor;
  },

  async luz() {
    const a = this.activo; if (!a) return;
    a.linterna = !a.linterna;
    try { await a.pista.applyConstraints({ advanced: [{ torch: a.linterna }] }); } catch (e) { a.linterna = false; }
    const b = document.getElementById('camaraLuz'); if (b) b.classList.toggle('activo', !!a.linterna);
  },

  // Con zoom se puede alejar el móvil: muchas cámaras no enfocan a menos de 10–20 cm.
  async cambiarZoom() {
    const a = this.activo; if (!a) return;
    const cap = capacidades(a.pista).zoom; if (!cap) return;
    const nuevo = this.zoom > 1 ? Math.max(1, cap.min) : Math.min(2, cap.max);
    try { await a.pista.applyConstraints({ advanced: [{ zoom: nuevo }] }); this.zoom = nuevo; } catch (e) { /* sin zoom */ }
    this.mostrarControles();
  },

  apagar(recordar = true) {
    const a = this.activo; this.activo = null;
    if (recordar) { try { localStorage.setItem('camara', 'no'); } catch (e) { /* sin almacenamiento */ } }
    if (a) { clearTimeout(a.temporizador); detener(a.flujo); a.video.srcObject = null; }
    const caja = document.getElementById('camara');
    if (caja && recordar) caja.innerHTML = '<div class="camara-off"><button class="btn" onclick="Escaner.encender()">Activar cámara</button></div>';
  },

  // Al cambiar de pantalla se apaga sin olvidar la preferencia de la persona.
  parar() { this.pendiente = false; if (this.activo) this.apagar(false); },

  manual() {
    const el = document.getElementById('codigoManual');
    const v = el.value.trim();
    if (v) { this.leido(v, true); el.value = ''; el.focus(); }
  },

  leido(txt, manual) {
    const codigo = String(txt).trim().toUpperCase();
    const ahora = Date.now();
    if (!manual && codigo === this.ultimo && ahora - this.ultimoT < 2500) return; // misma etiqueta aún delante de la cámara
    this.ultimo = codigo; this.ultimoT = ahora;
    pitido();
    const marco = document.getElementById('camaraMarco');
    if (marco && !manual) { marco.classList.remove('leido'); void marco.offsetWidth; marco.classList.add('leido'); }
    if (this.alLeer) this.alLeer(codigo);
  }
};

const espera = ms => new Promise(ok => setTimeout(ok, ms));
const conLimite = (promesa, ms, mensaje) => Promise.race([promesa, espera(ms).then(() => { throw new Error(mensaje); })]);
const detener = flujo => flujo.getTracks().forEach(t => t.stop());
const capacidades = pista => { try { return pista.getCapabilities ? pista.getCapabilities() : {}; } catch (e) { return {}; } };

function mensajeCamara(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'no hay permiso. Pulsa el candado de la barra de direcciones, permite la cámara y reintenta';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'no se encuentra ninguna cámara';
  if (n === 'NotReadableError' || n === 'AbortError') return 'la cámara está ocupada por otra aplicación o pestaña';
  return (e && e.message) || String(e);
}

// Enfoque continuo y algo de resolución extra si la cámara lo permite (cada móvil admite cosas distintas).
async function ajustarCamara(pista) {
  const cap = capacidades(pista);
  const avanzado = [];
  if (cap.focusMode && cap.focusMode.includes('continuous')) avanzado.push({ focusMode: 'continuous' });
  if (cap.exposureMode && cap.exposureMode.includes('continuous')) avanzado.push({ exposureMode: 'continuous' });
  for (const r of avanzado) { try { await pista.applyConstraints({ advanced: [r] }); } catch (e) { /* no lo admite */ } }
  Escaner.zoom = 1;
}

// Motor de lectura: nativo si lee Code 128; si no, ZXing (se descarga una vez y queda en caché).
let detectorListo = null;
function prepararDetector() {
  return detectorListo = detectorListo || (async () => {
    const forzar = new URLSearchParams(location.search).get('motor');
    if (forzar !== 'zxing' && 'BarcodeDetector' in window) {
      try {
        const admite = await BarcodeDetector.getSupportedFormats();
        if (admite.includes('code_128')) return { detector: new BarcodeDetector({ formats: FORMATOS.filter(f => admite.includes(f)) }), nombre: 'lector del móvil' };
      } catch (e) { /* se usa ZXing */ }
    }
    if (!window.BarcodeDetectionAPI) await cargarScript(MOTOR_ZXING);
    const detector = new window.BarcodeDetectionAPI.BarcodeDetector({ formats: FORMATOS });
    await detector.detect(document.createElement('canvas')).catch(() => {}); // descarga y prepara el WebAssembly ya
    return { detector, nombre: 'ZXing' };
  })().catch(e => { detectorListo = null; throw e; });
}
function cargarScript(src) {
  return new Promise((ok, mal) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => mal(new Error('no se ha podido cargar el lector de códigos. Revisa la conexión'));
    document.head.appendChild(s);
  });
}

// Copia a resolución completa la parte del vídeo que se ve en pantalla (el vídeo va recortado con
// object-fit: cover), con algo de margen alrededor del marco, que es donde la persona apunta.
const lienzoEscaner = document.createElement('canvas');
const GIROS = [0, 12, 0, -12, 0, 24, 0, -24].map(g => g * Math.PI / 180);
function recorteVisible(video, giro = 0) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const ew = video.clientWidth || vw, eh = video.clientHeight || vh;
  const escala = Math.max(ew / vw, eh / vh);
  const visW = Math.min(vw, ew / escala), visH = Math.min(vh, eh / escala);
  const w = Math.round(visW), h = Math.round(visH * 0.8);
  const x = Math.round((vw - w) / 2), y = Math.round((vh - h) / 2);
  if (lienzoEscaner.width !== w || lienzoEscaner.height !== h) { lienzoEscaner.width = w; lienzoEscaner.height = h; }
  const ctx = lienzoEscaner.getContext('2d', { willReadFrequently: true });
  if (!giro) ctx.drawImage(video, x, y, w, h, 0, 0, w, h);
  else {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.save(); ctx.translate(w / 2, h / 2); ctx.rotate(-giro); ctx.drawImage(video, -vw / 2, -vh / 2); ctx.restore();
  }
  return lienzoEscaner;
}

let audio;
function pitido() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 1150; g.gain.value = 0.08;
    o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.09);
  } catch (e) { /* sin audio */ }
  // El navegador solo deja vibrar después de que la persona haya tocado la página
  if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(50);
}
