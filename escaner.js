// Escáner de códigos: cámara en vivo y, como alternativa, escribir el código o usar un lector
// USB/Bluetooth (funciona como un teclado: escribe y pulsa Intro).
//
// Motor de lectura: el BarcodeDetector nativo del navegador (Android/Chrome, muy rápido) y ZXing-C++ en
// WebAssembly (barcode-detector), que es el único en iPhone y ordenadores y en Android entra a relevos con
// el nativo si este tarda en leer. Se pide a la cámara alta resolución, enfoque continuo y zoom ×2 (las
// etiquetas son de 50 × 10 mm: de cerca no enfocan y de lejos las barras se funden), y se analiza a
// resolución completa la parte del vídeo que se ve. Cada sesión deja un diagnóstico en el Log.

const MOTOR_ZXING = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.1/dist/iife/ponyfill.js';
const FORMATOS = ['code_128', 'qr_code', 'code_39', 'ean_13', 'ean_8'];

const Escaner = {
  activo: null,   // { flujo, video, pista, detectores, temporizador, vuelta, fallos, est }
  ultimo: '',
  ultimoT: 0,
  alLeer: null,
  encendiendo: false,
  pendiente: false,
  zoom: 1,
  camaras: [],    // cámaras traseras del dispositivo (se conocen tras dar permiso)

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
      flujo = await conLimite(abrirCamara(), 10000, 'la cámara no responde. Ciérrala en otras aplicaciones o pestañas y reintenta');
      if (!document.body.contains(caja)) { detener(flujo); return; } // se cambió de pantalla mientras tanto
      const pista = flujo.getVideoTracks()[0];
      await ajustarCamara(pista);
      this.camaras = await camarasTraseras();
      caja.innerHTML = `<video id="camaraVideo" playsinline muted autoplay></video><div class="camara-marco" id="camaraMarco"></div>
        <div class="camara-botones"><button class="btn ghost sm" id="camaraLente" hidden onclick="Escaner.cambiarCamara()">Cámara 1</button><button class="btn ghost sm" id="camaraLuz" hidden onclick="Escaner.luz()">Linterna</button><button class="btn ghost sm" id="camaraZoom" hidden onclick="Escaner.cambiarZoom()">Zoom ×1</button><button class="btn ghost sm" onclick="Escaner.apagar()">Parar</button></div>
        <div class="camara-info" id="camaraInfo"></div>`;
      const video = caja.querySelector('video');
      video.srcObject = flujo;
      await conLimite(video.play(), 5000, 'el vídeo de la cámara no arranca');
      const detectores = await conLimite(motor, 20000, 'no se ha podido cargar el lector de códigos. Revisa la conexión');
      if (!document.body.contains(video)) { detener(flujo); return; }
      this.activo = { flujo, video, pista, detectores, temporizador: 0, vuelta: 0, fallos: 0,
        est: { inicio: Date.now(), fotogramas: 0, ms: 0, lecturas: 0, primera: 0, nativo: 0, zxing: 0 } };
      if (!detectores.zxing) cargarZxing(detectores); // refuerzo listo por si el nativo no lee
      await this.ponerZoom(zoomPreferido(pista));
      video.onclick = ev => this.enfocar(ev);
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
    let espera = 60;
    if (!document.hidden && a.video.readyState >= 2 && a.video.videoWidth) {
      try {
        const d = a.detectores, n = ++a.vuelta;
        // Con lector nativo, ZXing entra un fotograma de cada dos en cuanto el nativo falla unas cuantas veces
        const usarZxing = !d.nativo || (a.fallos > 4 && n % 2 === 0 && !!d.zxing);
        const detector = usarZxing ? d.zxing : d.nativo;
        if (detector) {
          // ZXing solo lee códigos de barras casi horizontales: prueba también con el fotograma girado
          const giro = usarZxing ? GIROS[Math.floor(n / (d.nativo ? 2 : 1)) % GIROS.length] : 0;
          const t0 = performance.now();
          const codigos = await detector.detect(recorteVisible(a.video, giro));
          a.est.fotogramas++; a.est.ms += performance.now() - t0;
          const bueno = codigos.find(c => c.rawValue && c.rawValue.trim());
          if (bueno && this.activo === a) {
            a.fallos = 0; a.est.lecturas++; a.est[usarZxing ? 'zxing' : 'nativo']++;
            if (!a.est.primera) a.est.primera = Date.now() - a.est.inicio;
            this.leido(bueno.rawValue); espera = 400;
          } else a.fallos++;
        }
      } catch (e) { espera = 300; /* un fotograma que no se pudo leer: se sigue con el siguiente */ }
    } else espera = 200;
    if (this.activo === a) a.temporizador = setTimeout(() => this.analizar(), espera);
  },

  mostrarControles() {
    const a = this.activo; if (!a) return;
    const cap = capacidades(a.pista), ajustes = a.pista.getSettings ? a.pista.getSettings() : {};
    const luz = document.getElementById('camaraLuz'), zoom = document.getElementById('camaraZoom');
    if (luz) luz.hidden = !cap.torch;
    const lente = document.getElementById('camaraLente'), n = this.camaras.length;
    if (lente && n > 1) { lente.hidden = false; lente.textContent = 'Cámara ' + (indiceCamara(this.camaras, ajustes.deviceId) + 1) + '/' + n; }
    if (zoom && cap.zoom && cap.zoom.max >= 2) { zoom.hidden = false; zoom.textContent = 'Zoom ×' + redondo(this.zoom); }
    const info = document.getElementById('camaraInfo');
    if (info) info.textContent = (ajustes.width || a.video.videoWidth) + '×' + (ajustes.height || a.video.videoHeight) + ' · ' + nombreMotor(a.detectores) + (cap.zoom ? ' · ×' + redondo(this.zoom) : '');
  },

  async luz() {
    const a = this.activo; if (!a) return;
    a.linterna = !a.linterna;
    try { await a.pista.applyConstraints({ advanced: [{ torch: a.linterna }] }); } catch (e) { a.linterna = false; }
    const b = document.getElementById('camaraLuz'); if (b) b.classList.toggle('activo', !!a.linterna);
  },

  // Con zoom se puede alejar el móvil: muchas cámaras no enfocan a menos de 10–20 cm. Rota ×1 → ×2 → ×3
  // (según lo que admita la cámara) y recuerda la elección en este dispositivo.
  async cambiarZoom() {
    const a = this.activo; if (!a) return;
    const cap = capacidades(a.pista).zoom; if (!cap) return;
    const niveles = [1, 2, 3].filter(z => z <= cap.max);
    const nuevo = niveles[(niveles.indexOf(Math.round(this.zoom)) + 1) % niveles.length] || 1;
    await this.ponerZoom(nuevo);
    try { localStorage.setItem('camaraZoom', String(nuevo)); } catch (e) { /* sin almacenamiento */ }
    this.mostrarControles();
  },

  // Los móviles con varias cámaras traseras (gran angular, ultra gran angular, tele) no siempre abren la
  // mejor para leer de cerca: este botón pasa a la siguiente y el dispositivo recuerda la elección.
  async cambiarCamara() {
    const a = this.activo; if (!a || this.camaras.length < 2) return;
    const actual = indiceCamara(this.camaras, (a.pista.getSettings ? a.pista.getSettings() : {}).deviceId);
    const siguiente = this.camaras[(actual + 1) % this.camaras.length];
    try { localStorage.setItem('camaraId', siguiente.deviceId); } catch (e) { /* sin almacenamiento */ }
    this.apagar(false);
    await this.encender();
  },

  async ponerZoom(z) {
    const a = this.activo; if (!a) return;
    const cap = capacidades(a.pista).zoom; if (!cap || !z) return;
    const valor = Math.min(Math.max(z, cap.min || 1), cap.max);
    try { await a.pista.applyConstraints({ advanced: [{ zoom: valor }] }); this.zoom = valor; } catch (e) { /* sin zoom */ }
  },

  // Tocar el vídeo enfoca en ese punto (si la cámara lo admite) y vuelve después al enfoque continuo.
  async enfocar(ev) {
    const a = this.activo; if (!a) return;
    const modos = capacidades(a.pista).focusMode || [];
    if (!modos.includes('single-shot')) return;
    const r = a.video.getBoundingClientRect();
    const punto = { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height };
    try {
      await a.pista.applyConstraints({ advanced: [{ focusMode: 'single-shot', pointsOfInterest: [punto] }] });
      setTimeout(() => { if (this.activo === a && modos.includes('continuous')) a.pista.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}); }, 1500);
    } catch (e) { /* no lo admite */ }
  },

  apagar(recordar = true) {
    const a = this.activo; this.activo = null;
    if (recordar) { try { localStorage.setItem('camara', 'no'); } catch (e) { /* sin almacenamiento */ } }
    if (a) { clearTimeout(a.temporizador); enviarDiagnostico(a, this.zoom); detener(a.flujo); a.video.srcObject = null; }
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
const redondo = z => Math.round(z * 10) / 10;
const nombreMotor = d => d.nativo ? (d.zxing ? 'lector del móvil + ZXing' : 'lector del móvil') : 'ZXing';

function mensajeCamara(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'no hay permiso. Pulsa el candado de la barra de direcciones, permite la cámara y reintenta';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'no se encuentra ninguna cámara';
  if (n === 'NotReadableError' || n === 'AbortError') return 'la cámara está ocupada por otra aplicación o pestaña';
  return (e && e.message) || String(e);
}

// Abre la cámara elegida en este dispositivo o, si no hay ninguna (o ya no existe), la trasera por defecto.
// En Android se pide 4K: en vertical el vídeo solo tiene 1080 px de ancho y las barras de una etiqueta de
// 44 mm se quedan en 2–3 px; con más resolución se leen sin acercarse tanto. Si no la admite, da la máxima.
async function abrirCamara() {
  const android = /Android/i.test(navigator.userAgent);
  const tam = android ? { width: { ideal: 3840 }, height: { ideal: 2160 } } : { width: { ideal: 1920 }, height: { ideal: 1080 } };
  let id = null;
  try { id = localStorage.getItem('camaraId'); } catch (e) { /* sin almacenamiento */ }
  if (id) {
    try { return await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: id }, ...tam } }); }
    catch (e) { if (e && e.name === 'NotAllowedError') throw e; try { localStorage.removeItem('camaraId'); } catch (x) { /* sin almacenamiento */ } }
  }
  return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, ...tam } });
}

// Cámaras traseras (los nombres solo se conocen después de dar permiso). Si no se distingue cuáles son
// traseras (ordenadores), se devuelven todas.
async function camarasTraseras() {
  try {
    const todas = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput' && d.deviceId);
    const traseras = todas.filter(d => /back|rear|trasera|posterior|environment/i.test(d.label));
    return traseras.length ? traseras : todas;
  } catch (e) { return []; }
}
const indiceCamara = (lista, id) => Math.max(0, lista.findIndex(c => c.deviceId === id));

// Zoom de partida: el que eligió la persona en este dispositivo o, si no, ×2.
function zoomPreferido(pista) {
  const cap = capacidades(pista).zoom; if (!cap) return 0;
  let z = 2;
  try { z = Number(localStorage.getItem('camaraZoom')) || 2; } catch (e) { /* sin almacenamiento */ }
  return Math.min(z, cap.max);
}

// Enfoque y exposición continuos si la cámara lo permite (cada móvil admite cosas distintas).
async function ajustarCamara(pista) {
  const cap = capacidades(pista);
  const avanzado = [];
  if (cap.focusMode && cap.focusMode.includes('continuous')) avanzado.push({ focusMode: 'continuous' });
  if (cap.exposureMode && cap.exposureMode.includes('continuous')) avanzado.push({ exposureMode: 'continuous' });
  for (const r of avanzado) { try { await pista.applyConstraints({ advanced: [r] }); } catch (e) { /* no lo admite */ } }
  Escaner.zoom = 1;
}

// Motores de lectura: { nativo, zxing }. Si hay nativo que lea Code 128 se usa ya y ZXing se carga
// después en segundo plano (cargarZxing); si no, se espera a ZXing (se descarga una vez y queda en caché).
let detectorListo = null;
function prepararDetector() {
  return detectorListo = detectorListo || (async () => {
    const forzar = new URLSearchParams(location.search).get('motor');
    if (forzar !== 'zxing' && 'BarcodeDetector' in window) {
      try {
        const admite = await BarcodeDetector.getSupportedFormats();
        if (admite.includes('code_128')) return { nativo: new BarcodeDetector({ formats: FORMATOS.filter(f => admite.includes(f)) }), zxing: null };
      } catch (e) { /* se usa ZXing */ }
    }
    return { nativo: null, zxing: await nuevoZxing() };
  })().catch(e => { detectorListo = null; throw e; });
}
async function nuevoZxing() {
  if (!window.BarcodeDetectionAPI) await cargarScript(MOTOR_ZXING);
  const detector = new window.BarcodeDetectionAPI.BarcodeDetector({ formats: FORMATOS });
  await detector.detect(document.createElement('canvas')).catch(() => {}); // descarga y prepara el WebAssembly ya
  return detector;
}
// Carga ZXing como refuerzo en segundo plano, sin parar el escaneo.
function cargarZxing(d) {
  if (!d.cargandoZxing) d.cargandoZxing = nuevoZxing().then(z => { d.zxing = z; }).catch(() => { d.cargandoZxing = null; });
}
function cargarScript(src) {
  return new Promise((ok, mal) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => mal(new Error('no se ha podido cargar el lector de códigos. Revisa la conexión'));
    document.head.appendChild(s);
  });
}

// Al cerrar la cámara se manda al Log un resumen técnico de la sesión (sin imágenes) para poder
// depurar con datos de los móviles reales: modelo, lector, resolución, zoom, tiempos y lecturas.
function enviarDiagnostico(a, zoom) {
  try {
    const e = a.est, seg = Math.round((Date.now() - e.inicio) / 1000);
    if (seg < 3 || typeof api !== 'function') return;
    const cap = capacidades(a.pista), aj = a.pista.getSettings ? a.pista.getSettings() : {};
    api('diagnosticoEscaner', {
      dispositivo: navigator.userAgent, pantalla: location.hash, segundos: seg,
      motor: nombreMotor(a.detectores), resolucion: (aj.width || a.video.videoWidth) + 'x' + (aj.height || a.video.videoHeight),
      camara: (Escaner.camaras.find(c => c.deviceId === aj.deviceId) || {}).label || '', camaras: Escaner.camaras.map(c => c.label).join(' | '),
      zoom: redondo(zoom || 1), zoomMax: cap.zoom ? cap.zoom.max : null, enfoque: (cap.focusMode || []).join('/'), linterna: !!cap.torch,
      fotogramas: e.fotogramas, msPorFotograma: e.fotogramas ? Math.round(e.ms / e.fotogramas) : null,
      lecturas: e.lecturas, porNativo: e.nativo, porZxing: e.zxing, primeraLecturaMs: e.primera || null
    }).catch(() => {});
  } catch (x) { /* el diagnóstico nunca debe molestar */ }
}

// Copia a resolución completa la parte del vídeo que se ve en pantalla (el vídeo va recortado con
// object-fit: cover), con algo de margen alrededor del marco, que es donde la persona apunta.
const lienzoEscaner = document.createElement('canvas');
// ZXing tolera unos ±7° por intento: con pasos de 10° cubre etiquetas inclinadas hasta unos ±37°
const GIROS = [0, 10, -10, 0, 20, -20, 0, 30, -30].map(g => g * Math.PI / 180);
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
