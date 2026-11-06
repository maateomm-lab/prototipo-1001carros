/* Cotizador interno 1001Carros · lógica de la página. Habla con servidor.py (/api/...). */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const usd = v => v == null ? "–" : "$" + Math.round(v).toLocaleString("es-EC");
const pct = (v, d = 0) => (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";
const kmf = v => v == null ? "–" : Math.round(v).toLocaleString("es-EC") + " km";
const fecha = s => new Date(s).toLocaleString("es-EC", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fechaCorta = s => new Date(s).toLocaleString("es-EC", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = n => "N° " + String(n).padStart(5, "0");

const C = { pri: "#3730A3", deep: "#240078", yel: "#FECB00", lav: "rgba(99,102,241,.16)", tx2: "#6B7280", line: "#EEF0F4" };
const CHIP_TRANS = ["Automática", "Manual", "CVT", "DSG"];
const ESTADOS = ["Cotizada", "En negociación", "Comprada", "Perdida"];
const ETIQUETAS = { transmision: "Transmisión", combustible: "Combustible", traccion: "Tracción", cilindraje: "Cilindraje",
  ciudad: "Ciudad", provincia_placa: "Provincia placa", subtipo: "Carrocería", tapizado: "Tapizado", vidrios: "Vidrios",
  direccion: "Dirección", climatizacion: "Climatización", vendedor_tipo: "Lo vende" };

let YO = null, CAT = null;
let ultimo = null;          // última respuesta de /api/cotizar
let guardada = null;        // id de la cotización actual si ya se guardó
let ofertaManual = false;   // el asesor escribió la oferta final a mano
const charts = {};
const ESTADO_INICIAL = () => ({ marca: null, familia: null, version: null, anio: 2018, km: 80000, cilindraje: null,
  pn_con_iva: null, margen: CAT ? CAT.margen : 0.11, campos: { vendedor_tipo: "particular" } });
let st = ESTADO_INICIAL();

// ------------------------------------------------------------------ llamadas al servidor
async function api(url, body, metodo) {
  const r = await fetch(url, body === undefined ? {} : { method: metodo || "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { mostrarLogin(); throw new Error(j.error || "Sesión terminada"); }
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
}

function toast(html, ms = 3500) {
  const t = $("#toast");
  t.innerHTML = html; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => t.hidden = true, ms);
}

function error(el, msg) { el.textContent = msg; el.hidden = !msg; }

// ------------------------------------------------------------------ ingreso
arranque();
async function arranque() {
  const s = await (await fetch("/api/sesion")).json();
  if (s.usuario) entrar(s.usuario);
  else mostrarLogin(s.setup);
}

function mostrarLogin(setup = false) {
  $("#app").hidden = true; $("#login").hidden = false;
  $("#setup-campos").hidden = !setup;
  $("#f-login").dataset.setup = setup ? "1" : "";
  $("#login-tit").textContent = setup ? "Configuración inicial" : "Cotizador interno";
  $("#login-sub").textContent = setup ? "Crea el usuario administrador (gerencia). Después podrás crear las cuentas de los asesores."
                                      : "Ingresa con tu usuario de 1001Carros.";
  $("#login-btn").textContent = setup ? "Crear administrador" : "Ingresar";
  $('#f-login [name="clave"]').autocomplete = setup ? "new-password" : "current-password";
  $('#f-login [name="nombre"]').required = setup;
}

$("#f-login").addEventListener("submit", async e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  error($("#login-err"), "");
  $("#login-btn").disabled = true;
  try {
    const r = await api(e.target.dataset.setup ? "/api/setup" : "/api/login", f);
    e.target.reset();
    entrar(r.usuario);
  } catch (err) { error($("#login-err"), err.message); }
  finally { $("#login-btn").disabled = false; }
});

async function entrar(u) {
  YO = u;
  $("#login").hidden = true; $("#app").hidden = false;
  $("#yo-nombre").textContent = u.nombre;
  $("#yo-rol").textContent = u.rol === "admin" ? "Administrador" : "Asesor";
  $("#yo-ini").textContent = u.nombre.split(/\s+/).map(p => p[0]).slice(0, 2).join("").toUpperCase();
  $$(".solo-admin").forEach(el => el.hidden = u.rol !== "admin");
  if (!CAT) {
    CAT = await api("/api/catalogo");
    st = ESTADO_INICIAL();
    armarCotizador();
  }
  router();
}

$("#btn-salir").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  YO = null; mostrarLogin();
});

$("#btn-clave").addEventListener("click", () => { $("#f-clave").reset(); error($("#clave-err"), ""); $("#m-clave").hidden = false; });
$("#f-clave").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await api("/api/yo/clave", Object.fromEntries(new FormData(e.target)));
    $("#m-clave").hidden = true;
    mostrarLogin(); toast("Contraseña cambiada. Ingresa con la nueva.");
  } catch (err) { error($("#clave-err"), err.message); }
});

$$(".modal").forEach(m => m.addEventListener("click", e => { if (e.target === m || e.target.closest("[data-cerrar]")) m.hidden = true; }));
document.addEventListener("keydown", e => { if (e.key === "Escape") $$(".modal").forEach(m => m.hidden = true); });

// ------------------------------------------------------------------ navegación entre pantallas
window.addEventListener("hashchange", router);
function router() {
  if (!YO) return;
  let v = location.hash.replace("#/", "") || "nueva", arg = null;
  if (v === "comite") v = "tablero";                 // el "Comité" pasó a llamarse Tablero de objetivos
  if (v.startsWith("unidad/")) [v, arg] = v.split("/");
  if ((v === "usuarios" || v === "parametros") && YO.rol !== "admin") v = "nueva";
  $$(".vista").forEach(s => s.hidden = s.dataset.vista !== v);
  $$(".side-nav a").forEach(a => a.classList.toggle("on", a.dataset.v === (v === "unidad" ? "inventario" : v)));
  if (v === "historial") cargarHistorial();
  if (v === "resumen") cargarResumen();
  if (v === "usuarios") cargarUsuarios();
  if (v === "inventario") cargarInventario();
  if (v === "unidad") cargarUnidad(arg);
  if (v === "tablero") cargarTablero();
  if (v === "parametros") cargarParametros();
  window.scrollTo(0, 0);
}

// ================================================================== NUEVA COTIZACIÓN
function armarCotizador() {
  const marcas = Object.keys(CAT.marcas).sort((a, b) => CAT.marcas[b].n - CAT.marcas[a].n);
  $("#in-anio").max = CAT.anio_ref + 1;
  $("#pn-err1").textContent = CAT.metricas.con_pn["MdAPE %"].toFixed(1) + "%";
  $("#pn-err2").textContent = CAT.metricas.sin_pn["MdAPE %"].toFixed(1) + "%";
  const opcEstados = ESTADOS.map(e => `<option>${e}</option>`).join("");
  $$('select[name="estado"]').forEach(s => s.innerHTML = opcEstados);
  $("#h-estado").innerHTML += opcEstados;

  $("#pop-marcas").innerHTML = marcas.slice(0, 8).map(m => `<button type="button" class="chip" data-m="${esc(m)}">${esc(m)}</button>`).join("");
  $("#pop-marcas").addEventListener("click", e => { const b = e.target.closest(".chip"); if (b) elegirMarca(b.dataset.m); });

  combo($("#cb-marca"), () => marcas.map(m => ({ id: m, txt: m, n: CAT.marcas[m].n })), it => elegirMarca(it.id));
  combo($("#cb-modelo"), () => st.marca ? CAT.marcas[st.marca].modelos.map(f => ({ id: f.id, txt: f.nombre, n: f.n })) : [],
        it => elegirModelo(it.id));
  $("#sel-version").addEventListener("change", e => { st.version = e.target.value || null; cambioAuto(); });

  armarDetalles();
  armarUso();
  armarResultado();
  armarCliente();
  armarNuevaUnidad();
  $("#btn-limpiar").addEventListener("click", () => cargarEntrada(null));
}

function combo(root, items, onPick) {
  const inp = $("input", root), ul = $(".combo-list", root);
  let act = 0, vis = [];
  const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const pintar = () => {
    const q = norm(inp.value.trim());
    vis = items().filter(it => !q || norm(it.txt).includes(q)).slice(0, 80);
    act = Math.min(act, Math.max(vis.length - 1, 0));
    ul.innerHTML = vis.length ? vis.map((it, i) =>
      `<li data-i="${i}" class="${i === act ? "act" : ""}"><span>${esc(it.txt)}</span><small>${it.n ? it.n + " avisos" : "pocos datos"}</small></li>`).join("")
      : `<li class="vacio">Sin resultados</li>`;
  };
  const elegir = i => { if (!vis[i]) return; inp.value = vis[i].txt; root.classList.remove("open"); onPick(vis[i]); };
  inp.addEventListener("focus", () => { inp.select(); act = 0; pintar(); root.classList.add("open"); });
  inp.addEventListener("input", () => { act = 0; pintar(); root.classList.add("open"); });
  inp.addEventListener("blur", () => setTimeout(() => root.classList.remove("open"), 150));
  inp.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { act = Math.min(act + 1, vis.length - 1); pintar(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { act = Math.max(act - 1, 0); pintar(); e.preventDefault(); }
    else if (e.key === "Enter") { elegir(act); e.preventDefault(); }
    else if (e.key === "Escape") root.classList.remove("open");
  });
  ul.addEventListener("mousedown", e => { const li = e.target.closest("li[data-i]"); if (li) elegir(+li.dataset.i); });
}

function elegirMarca(m, enfocar = true) {
  st.marca = m; st.familia = null; st.version = null;
  $("#cb-marca input").value = m;
  $$("#pop-marcas .chip").forEach(c => c.classList.toggle("on", c.dataset.m === m));
  const mi = $("#cb-modelo input");
  mi.disabled = false; mi.value = ""; mi.placeholder = `Modelos de ${m}…`;
  $("#sel-version").disabled = true;
  $("#sel-version").innerHTML = `<option value="">No sé / estándar</option>`;
  if (enfocar) mi.focus();
}

function elegirModelo(id, version = null) {
  const f = CAT.marcas[st.marca].modelos.find(x => x.id === id);
  if (!f) return;
  st.familia = id; st.version = version;
  $("#cb-modelo input").value = f.nombre;
  const sv = $("#sel-version");
  sv.innerHTML = `<option value="">No sé / estándar</option>` + f.versiones.map(v => `<option value="${esc(v.id)}">${esc(v.nombre)}</option>`).join("");
  sv.disabled = !f.versiones.length;
  sv.value = version || "";
  cambioAuto();
}

function rellenoSlider(r) { r.style.setProperty("--p", ((r.value - r.min) / (r.max - r.min)) * 100 + "%"); }

function pistaKm() {
  const edad = Math.max(CAT.anio_ref - st.anio, 1), ritmo = st.km / edad;
  const txt = ritmo < 8000 ? "Poco uso para su edad" : ritmo > 25000 ? "Uso intenso para su edad" : "Uso normal para su edad";
  $("#km-hint").textContent = `${Math.round(ritmo).toLocaleString("es-EC")} km/año · ${txt}`;
}

function sincronizarUso() {
  const ra = $("#in-anio"), rk = $("#in-km");
  ra.value = st.anio; $("#out-anio").textContent = st.anio;
  rk.value = Math.min(st.km, 400000); $("#in-km-num").value = st.km;
  [ra, rk].forEach(rellenoSlider);
  pistaKm();
}

function armarUso() {
  const ra = $("#in-anio"), rk = $("#in-km"), nk = $("#in-km-num");
  ra.addEventListener("input", () => { st.anio = +ra.value; sincronizarUso(); cambioAuto(); });
  rk.addEventListener("input", () => { st.km = +rk.value; sincronizarUso(); cambioAuto(); });
  nk.addEventListener("input", () => { st.km = Math.max(0, +nk.value || 0); rk.value = Math.min(st.km, 400000); rellenoSlider(rk); pistaKm(); cambioAuto(); });
  sincronizarUso();
}

function ponerKm(k) { st.km = Math.round(k / 1000) * 1000; sincronizarUso(); cambioAuto(); }

function armarDetalles() {
  $$(".chips[data-campo]").forEach(box => {
    const campo = box.dataset.campo;
    let vals = CAT.valores[campo] || [];
    if (campo === "transmision") vals = CHIP_TRANS.filter(v => vals.includes(v));
    box.innerHTML = vals.map(v => `<button type="button" class="chip" data-v="${esc(v)}">${esc(v)}</button>`).join("");
    box.addEventListener("click", e => {
      const b = e.target.closest(".chip"); if (!b) return;
      st.campos[campo] = st.campos[campo] === b.dataset.v ? null : b.dataset.v;   // segundo clic = "no sé"
      sincronizarDetalles(); cambioAuto();
    });
  });
  $$("select[data-sel]").forEach(sel => {
    const campo = sel.dataset.sel;
    sel.innerHTML = `<option value="">No sé</option>` + (CAT.valores[campo] || []).map(v => `<option>${esc(v)}</option>`).join("");
    sel.addEventListener("change", () => { st.campos[campo] = sel.value || null; cambioAuto(); });
  });
  $("#in-cil").addEventListener("input", e => { st.cilindraje = +e.target.value || null; cambioAuto(); });
  $("#in-pn").addEventListener("input", e => { st.pn_con_iva = +e.target.value || null; cambioAuto(); });
  sincronizarDetalles();
}

function sincronizarDetalles() {
  $$(".chips[data-campo]").forEach(box => $$(".chip", box).forEach(c => c.classList.toggle("on", st.campos[box.dataset.campo] === c.dataset.v)));
  $$("select[data-sel]").forEach(s => s.value = st.campos[s.dataset.sel] || "");
  $("#in-cil").value = st.cilindraje || ""; $("#in-pn").value = st.pn_con_iva || "";
}

/** Carga un auto en el formulario (null = formulario vacío). Se usa en "Empezar otra" y "Recotizar". */
function cargarEntrada(e) {
  const campos = { vendedor_tipo: "particular" };
  if (e) Object.keys(ETIQUETAS).forEach(k => { if (k !== "cilindraje" && e[k]) campos[k] = e[k]; });
  st = { ...ESTADO_INICIAL(), ...(e ? { anio: e.anio, km: e.km ?? 80000, cilindraje: e.cilindraje || null, pn_con_iva: e.pn_con_iva || null } : {}), campos };
  ultimo = null; nuevaCotizacion();
  $("#f-cliente").reset();
  $("#cb-marca input").value = ""; $("#cb-modelo input").value = ""; $("#cb-modelo input").disabled = true;
  $("#cb-modelo input").placeholder = "Elige primero la marca";
  $("#sel-version").disabled = true; $("#sel-version").innerHTML = `<option value="">No sé / estándar</option>`;
  $$("#pop-marcas .chip").forEach(c => c.classList.remove("on"));
  $("#res-empty").hidden = false; $("#res-full").hidden = true;
  $("#in-margen").value = st.margen * 100; $("#in-margen").dispatchEvent(new Event("input"));
  sincronizarUso(); sincronizarDetalles();
  if (e && CAT.marcas[e.marca]) { elegirMarca(e.marca, false); elegirModelo(e.familia, e.version); }
}

// ------------------------------------------------------------------ cotizar (en vivo, con espera corta)
let timer = null, pedido = 0;
function cambioAuto() { nuevaCotizacion(); cotizar(); }

function entrada() {
  return { marca: st.marca, familia: st.familia, version: st.version, anio: st.anio, km: st.km,
           cilindraje: st.cilindraje, pn_con_iva: st.pn_con_iva, margen: st.margen, ...st.campos };
}

function cotizar() {
  if (!st.familia) return;
  clearTimeout(timer);
  $(".res-main").classList.add("cargando"); $("#spin").classList.add("on");
  timer = setTimeout(async () => {
    const id = ++pedido;
    try {
      const r = await api("/api/cotizar", entrada());
      if (id !== pedido) return;          // llegó una respuesta vieja: se ignora
      ultimo = r; pintar(r);
    } catch (e) {
      mostrarAlerta("warn", "⚠️", "No se pudo calcular: " + esc(e.message));
    } finally {
      if (id === pedido) { $(".res-main").classList.remove("cargando"); $("#spin").classList.remove("on"); }
    }
  }, 280);
}

function armarResultado() {
  const rm = $("#in-margen");
  rm.addEventListener("input", () => {
    st.margen = rm.value / 100; $("#out-margen").textContent = (+rm.value).toFixed(1) + "%"; rellenoSlider(rm);
    if (ultimo) pintarOferta(ultimo.resultado, false);
  });
  rm.value = st.margen * 100; rm.dispatchEvent(new Event("input"));
  $$(".tab").forEach(t => t.addEventListener("click", () => {
    $$(".tab").forEach(x => x.classList.toggle("on", x === t));
    $$(".tab-p").forEach(p => p.hidden = p.dataset.tp !== t.dataset.t);
    if (t.dataset.t === "efectos" && ultimo) pintarEfectos(ultimo);
  }));
}

function animarNumero(el, hasta, ms = 600) {
  const desde = el._v || 0, t0 = performance.now();
  el._v = hasta;
  const paso = t => {
    const k = Math.min((t - t0) / ms, 1), e = 1 - Math.pow(1 - k, 3);
    if (el._v !== hasta) return;
    el.textContent = usd(desde + (hasta - desde) * e);
    if (k < 1) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
  setTimeout(() => { if (el._v === hasta) el.textContent = usd(hasta); }, ms + 50);   // por si la pestaña está en segundo plano
}

function mostrarAlerta(tipo, ico, html) {
  const a = $("#alerta");
  a.className = "alert " + tipo; a.innerHTML = `<span>${ico}</span><span>${html}</span>`; a.hidden = false;
}

function textoVehiculo() {
  const f = CAT.marcas[st.marca].modelos.find(x => x.id === st.familia);
  const ver = st.version ? f.versiones.find(v => v.id === st.version)?.nombre : "";
  return `${st.marca} ${f.nombre}${ver ? " " + ver : ""} ${st.anio}`;
}

function pintar(r) {
  $("#res-empty").hidden = true; $("#res-full").hidden = false;
  const R = r.resultado;
  $("#res-titulo").textContent = textoVehiculo();
  $("#res-sub").textContent = kmf(st.km) + (R.pn_con_iva ? ` · precio de nuevo ${usd(R.pn_con_iva)}${r.pn_detectado ? " (catálogo)" : ""}` : "");
  animarNumero($("#v-mercado"), R.mercado);

  const pos = v => ((v - R.bajo) / (R.alto - R.bajo)) * 100;
  $("#r50").style.left = pos(R.bajo50) + "%"; $("#r50").style.width = (pos(R.alto50) - pos(R.bajo50)) + "%";
  $("#mark").style.left = pos(R.mercado) + "%";
  $("#v-bajo").textContent = usd(R.bajo); $("#v-alto").textContent = usd(R.alto);
  $("#v-r50").textContent = `${usd(R.bajo50)} – ${usd(R.alto50)}`;

  const c = r.confianza, conf = $("#conf");
  conf.className = "conf " + c.nivel;
  $("#conf-txt").textContent = { alta: "Confianza alta", media: "Confianza media", baja: "Confianza baja" }[c.nivel];
  conf.title = `Rango probable ±${c.ancho.toFixed(0)}% · ${c.n_modelo} avisos de este modelo`;

  if (R.fuera_de_rango)
    mostrarAlerta("warn", "💎", `Gama alta (sobre ${usd(CAT.limite_confiable)}): hay pocos avisos de esta gama y el error típico sube a ±${CAT.metricas.sobre_60k["MdAPE %"].toFixed(0)}%. Usa el valor como punto de partida y haz una tasación manual.`);
  else if (c.n_modelo < 10)
    mostrarAlerta("warn", "🔍", `Solo hay <b>${c.n_modelo}</b> avisos de este modelo en el mercado. El modelo se apoya en carros parecidos, por eso el rango es más ancho. Revisa los comparables antes de ofertar.`);
  else if (c.nivel === "alta")
    mostrarAlerta("info", "✅", `Estimación precisa: <b>${c.n_modelo}</b> avisos de este modelo y rango probable de ±${c.ancho.toFixed(0)}%.`);
  else if (!R.pn_con_iva)
    mostrarAlerta("info", "💡", `No encontramos el precio de nuevo de este modelo. Si lo ingresas en <b>Precio de nuevo</b>, la estimación mejora.`);
  else $("#alerta").hidden = true;

  pintarOferta(R, true);
  pintarComparables(r); pintarKm(r); pintarAnios(r);
  if (!$('[data-tp="efectos"]').hidden) pintarEfectos(r);
}

const toma = v => v / (1 + st.margen);

function pintarOferta(R, animar) {
  if (animar) animarNumero($("#v-toma"), toma(R.mercado)); else { $("#v-toma")._v = toma(R.mercado); $("#v-toma").textContent = usd(toma(R.mercado)); }
  $("#v-toma-r").textContent = `${usd(toma(R.bajo50))} – ${usd(toma(R.alto50))}`;
  if (!ofertaManual) $('#f-cliente [name="oferta_final"]').value = Math.round(toma(R.mercado) / 100) * 100;
}

// ------------------------------------------------------------------ cliente, guardar e imprimir
function armarCliente() {
  const f = $("#f-cliente");
  f.addEventListener("input", e => {
    if (e.target.name === "oferta_final") ofertaManual = true;
    if (guardada) $("#btn-guardar").textContent = `Guardar cambios en ${num(guardada)}`;
  });
  f.addEventListener("submit", async e => {
    e.preventDefault();
    if (!ultimo) return;
    const datos = Object.fromEntries(new FormData(f));
    datos.oferta_final = +datos.oferta_final || null;
    const btn = $("#btn-guardar"); btn.disabled = true;
    try {
      if (guardada) {
        await api(`/api/cotizaciones/${guardada}`, datos);
        toast(`${num(guardada)} actualizada`);
      } else {
        const r = await api("/api/cotizaciones", { ...datos, entrada: entrada(), vehiculo: textoVehiculo(),
          resultado: ultimo.resultado, confianza: ultimo.confianza.nivel, margen: st.margen, oferta: toma(ultimo.resultado.mercado) });
        guardada = r.id;
        toast(`Cotización ${num(r.id)} guardada <a href="#/historial">Ver historial</a>`);
      }
      $("#guardada-pill").textContent = `${num(guardada)} · guardada`; $("#guardada-pill").hidden = false;
      btn.textContent = "Guardada ✓";
    } catch (err) { toast("⚠️ " + esc(err.message)); }
    finally { btn.disabled = false; }
  });
  $("#btn-imprimir").addEventListener("click", () => {
    if (!ultimo) return;
    const d = Object.fromEntries(new FormData(f));
    imprimir({ id: guardada, fecha: new Date().toISOString(), asesor: YO.nombre, ...d, oferta_final: +d.oferta_final || toma(ultimo.resultado.mercado),
               vehiculo: textoVehiculo(), km: st.km, mercado: ultimo.resultado.mercado, bajo50: ultimo.resultado.bajo50,
               alto50: ultimo.resultado.alto50, datos: { entrada: entrada() } });
  });
}

/** Cualquier cambio en el auto convierte la cotización en una nueva (la guardada no se toca). */
function nuevaCotizacion() {
  guardada = null; ofertaManual = false;
  $("#guardada-pill").hidden = true;
  $("#btn-guardar").textContent = "Guardar cotización";
}

function imprimir(c) {
  const e = c.datos?.entrada || {};
  const extra = Object.entries(ETIQUETAS).filter(([k]) => e[k] && k !== "vendedor_tipo").map(([k, t]) => [t, k === "cilindraje" ? e[k] + " cc" : e[k]]);
  const filas = arr => arr.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v || "–")}</b></div>`).join("");
  $("#hoja").innerHTML = `
    <div class="hoja-head">
      <div><div class="logo"><span class="logo-1001">1001</span>Carros</div><small>Cotización de compra de vehículo usado</small></div>
      <div class="hoja-num"><b>${c.id ? num(c.id) : "Borrador"}</b>${fecha(c.fecha)}<br>Asesor: ${esc(c.asesor || YO.nombre)}</div>
    </div>
    <h4>Cliente</h4>
    <div class="hoja-datos">${filas([["Nombre", c.cliente], ["Teléfono", c.telefono], ["Correo", c.correo]])}</div>
    <h4>Vehículo</h4>
    <div class="hoja-datos">${filas([["Vehículo", c.vehiculo], ["Kilometraje", kmf(c.km)], ["Placa", c.placa], ["Color", c.color], ...extra])}</div>
    <div class="hoja-oferta">
      <div><small>Valor de mercado estimado</small><b>${usd(c.mercado)}</b><small>Rango probable ${usd(c.bajo50)} – ${usd(c.alto50)}</small></div>
      <div class="grande"><small>Oferta de compra 1001Carros</small><b>${usd(c.oferta_final)}</b></div>
    </div>
    ${c.notas ? `<h4>Observaciones</h4><p>${esc(c.notas)}</p>` : ""}
    <p class="hoja-legal">Oferta referencial válida por 7 días calendario. Sujeta a inspección mecánica, revisión legal del vehículo
      (matrícula, multas, gravámenes) y verificación de documentos. El valor de mercado es una estimación basada en avisos
      publicados en Ecuador y no constituye un avalúo oficial.</p>
    <div class="hoja-firmas"><div>Asesor 1001Carros</div><div>Cliente</div></div>`;
  window.print();
}

// ------------------------------------------------------------------ gráficos
Chart.defaults.font.family = "Inter, system-ui, sans-serif";
Chart.defaults.color = C.tx2;

function grafico(id, cfg) {
  if (charts[id]) { charts[id].data = cfg.data; charts[id].options = cfg.options; charts[id].update(); return charts[id]; }
  return (charts[id] = new Chart($("#" + id), cfg));
}

function opcionesLinea(xTitulo, xFmt, extra = {}) {
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 500 },
    interaction: { mode: "nearest", intersect: false, axis: "x" },
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: C.deep, padding: 10, displayColors: false,
        filter: it => it.datasetIndex === 2 || it.datasetIndex === 3,
        callbacks: { title: it => xFmt(it[0].parsed.x), label: it => (it.datasetIndex === 3 ? "Este carro: " : "Valor: ") + usd(it.parsed.y) } },
    },
    scales: {
      x: { type: "linear", title: { display: true, text: xTitulo }, grid: { color: C.line }, ticks: { callback: xFmt } },
      y: { grid: { color: C.line }, ticks: { callback: v => "$" + (v / 1000).toFixed(0) + "k" } },
    },
    ...extra,
  };
}

function datasetsBanda(pts, x, actual) {
  return [
    { data: pts.map(p => ({ x: p[x], y: p.alto50 })), borderWidth: 0, pointRadius: 0, fill: "+1", backgroundColor: C.lav },
    { data: pts.map(p => ({ x: p[x], y: p.bajo50 })), borderWidth: 0, pointRadius: 0, fill: false },
    { data: pts.map(p => ({ x: p[x], y: p.mercado })), borderColor: C.pri, borderWidth: 3, pointRadius: 0, pointHoverRadius: 5, tension: .35, fill: false },
    { data: [actual], type: "scatter", pointRadius: 9, pointHoverRadius: 11, backgroundColor: C.yel, borderColor: C.deep, borderWidth: 3 },
  ];
}

function interp(pts, x, k, v) {
  for (let i = 1; i < pts.length; i++) if (pts[i][k] >= x) {
    const a = pts[i - 1], b = pts[i], t = (x - a[k]) / (b[k] - a[k]);
    return a[v] + t * (b[v] - a[v]);
  }
  return pts[pts.length - 1][v];
}

function pintarKm(r) {
  const pts = r.curva_km, R = r.resultado;
  grafico("ch-km", { type: "line", data: { datasets: datasetsBanda(pts, "km", { x: st.km, y: R.mercado }) },
    options: opcionesLinea("Kilometraje", v => Math.round(v / 1000) + "k km", {
      onClick: (e, _, ch) => { const x = ch.scales.x.getValueForPixel(e.x); if (x >= 0) ponerKm(x); },
      onHover: (e, _, ch) => { ch.canvas.style.cursor = "pointer"; },
    }) });
  const maxKm = pts[pts.length - 1].km;
  $("#km-cards").innerHTML = [-50000, -25000, 25000, 50000, 100000].filter(d => st.km + d >= 0 && st.km + d <= maxKm).map(d => {
    const v = interp(pts, st.km + d, "km", "mercado"), dif = v / R.mercado - 1;
    return `<div class="km-card"><small>${d > 0 ? "+" : ""}${(d / 1000)}k km</small><b>${usd(v)}</b><div class="d ${dif >= 0 ? "up" : "down"}">${pct(dif, 1)}</div></div>`;
  }).join("");
}

function pintarAnios(r) {
  const pts = r.curva_anios;
  $("#anios-hint").textContent = `Cuánto valdría este carro en los próximos años si sigue rodando ~${Math.round(r.ritmo_km).toLocaleString("es-EC")} km/año (sin inflación). Útil para estimar cuánto pierde si se queda en el patio.`;
  grafico("ch-anios", { type: "line", data: { datasets: datasetsBanda(pts, "t", { x: 0, y: pts[0].mercado }) },
    options: opcionesLinea("Años desde hoy", v => v === 0 ? "Hoy" : "+" + v + (v === 1 ? " año" : " años")) });
  $("#anios-cards").innerHTML = pts.filter(p => [1, 2, 3, 5].includes(p.t)).map(p => {
    const dif = p.mercado / pts[0].mercado - 1;
    return `<div class="km-card"><small>En ${p.t} año${p.t > 1 ? "s" : ""} · ${Math.round(p.km / 1000)}k km</small><b>${usd(p.mercado)}</b><div class="d down">${pct(dif, 1)}</div></div>`;
  }).join("");
}

function pintarEfectos(r) {
  $("#v-base").textContent = usd(r.resultado.base);
  const ef = r.efectos.filter(e => Math.abs(e.efecto) >= 0.001).slice(0, 10);
  const max = Math.max(...ef.map(e => Math.abs(e.efecto)), 0.01);
  $("#efectos").innerHTML = ef.map(e => `<div class="ef"><span>${esc(e.factor)}</span><div class="ef-track"><div class="ef-bar ${e.efecto >= 0 ? "pos" : "neg"}" data-w="${(Math.abs(e.efecto) / max) * 50}"></div></div><span class="ef-v ${e.efecto >= 0 ? "up" : "down"}">${pct(e.efecto)}</span></div>`).join("");
  requestAnimationFrame(() => $$(".ef-bar").forEach(b => b.style.width = b.dataset.w + "%"));
}

function pintarComparables(r) {
  const cs = r.comparables, R = r.resultado;
  if (!cs.length) {
    $("#comp-hint").textContent = "No encontramos avisos de este modelo con años parecidos.";
    $("#comp-list").innerHTML = ""; if (charts["ch-comp"]) { charts["ch-comp"].destroy(); delete charts["ch-comp"]; }
    return;
  }
  const cerca = cs.filter(c => Math.abs(c.anio - st.anio) <= 1).map(c => c.precio).sort((a, b) => a - b);
  const med = cerca.length ? cerca[Math.floor(cerca.length / 2)] : null;
  $("#comp-hint").innerHTML = `<b>${cs.length}</b> avisos publicados del mismo modelo (±4 años; los más oscuros son de ${st.anio}).` +
    (med ? ` Precio mediano de los ${cerca.length} avisos de ${st.anio - 1}–${st.anio + 1}: <b>${usd(med)}</b>.` : "") + ` Toca un punto para abrir el aviso.`;
  grafico("ch-comp", { type: "scatter", data: { datasets: [
      { data: cs.map(c => ({ x: c.km ?? 0, y: c.precio, c })), backgroundColor: cs.map(c => c.anio === st.anio ? "rgba(55,48,163,.75)" : "rgba(55,48,163,.25)"), pointRadius: 6, pointHoverRadius: 8 },
      { data: [{ x: st.km, y: R.mercado }], backgroundColor: C.yel, borderColor: C.deep, borderWidth: 3, pointRadius: 10, pointStyle: "star" },
    ] },
    options: { responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      onClick: (e, els) => { const el = els.find(x => x.datasetIndex === 0); if (el) window.open(cs[el.index].url, "_blank", "noopener"); },
      onHover: (e, els, ch) => { ch.canvas.style.cursor = els.length ? "pointer" : "default"; },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: C.deep, padding: 10, displayColors: false, callbacks: {
        title: it => it[0].datasetIndex === 1 ? "Este carro (estimado)" : it[0].raw.c.titulo,
        label: it => it.datasetIndex === 1 ? usd(it.parsed.y) : [`${usd(it.parsed.y)} · ${kmf(it.parsed.x)}`, it.raw.c.ciudad || ""] } } },
      scales: { x: { title: { display: true, text: "Kilometraje" }, grid: { color: C.line }, ticks: { callback: v => Math.round(v / 1000) + "k" } },
                y: { grid: { color: C.line }, ticks: { callback: v => "$" + (v / 1000).toFixed(0) + "k" } } } } });
  $("#comp-list").innerHTML = cs.slice(0, 6).map(c => `<a class="comp" href="${esc(c.url)}" target="_blank" rel="noopener">
      <h5>${esc(c.titulo)}</h5><p>${c.km != null ? kmf(c.km) : "km no indicado"}${c.ciudad ? " · " + esc(c.ciudad) : ""}</p>
      <div class="pr"><b>${usd(c.precio)}</b><span class="d ${c.dif >= 0 ? "up" : "down"}">${pct(c.dif)} vs estimado</span></div></a>`).join("");
}

// ================================================================== HISTORIAL
let hTimer = null;
["#h-texto", "#h-estado", "#h-asesor"].forEach(s => $(s).addEventListener("input", () => { clearTimeout(hTimer); hTimer = setTimeout(cargarHistorial, 250); }));

const pill = e => `<span class="pill e-${e.replace(/ /g, "-")}">${esc(e)}</span>`;

async function cargarHistorial() {
  const qs = new URLSearchParams({ texto: $("#h-texto").value, estado: $("#h-estado").value, asesor: $("#h-asesor").value });
  try {
    if (YO.rol === "admin" && $("#h-asesor").options.length === 1) {
      const us = await api("/api/usuarios");
      $("#h-asesor").innerHTML += us.map(u => `<option value="${esc(u.usuario)}">${esc(u.nombre)}</option>`).join("");
    }
    const filas = await api("/api/cotizaciones?" + qs);
    $("#hist-sub").textContent = `${filas.length} cotizaci${filas.length === 1 ? "ón" : "ones"}` + (YO.rol === "admin" ? " del equipo" : " tuyas");
    $("#h-vacio").hidden = filas.length > 0;
    $("#h-tabla tbody").innerHTML = filas.map(c => `<tr class="clic" data-id="${c.id}">
      <td class="nw"><b>${num(c.id)}</b></td><td class="nw">${fechaCorta(c.fecha)}</td>
      <td>${esc(c.cliente || "–")}<small>${esc(c.telefono || "")}</small></td>
      <td>${esc(c.vehiculo)}<small>${esc(c.placa || "")}</small></td>
      <td class="num nw">${kmf(c.km)}</td><td class="num nw">${usd(c.mercado)}</td><td class="num nw"><b>${usd(c.oferta_final)}</b></td>
      <td>${pill(c.estado)}</td><td class="solo-admin" ${YO.rol !== "admin" ? "hidden" : ""}>${esc(c.asesor || c.usuario)}</td></tr>`).join("");
  } catch (e) { toast("⚠️ " + esc(e.message)); }
}

$("#h-tabla tbody").addEventListener("click", e => { const tr = e.target.closest("tr[data-id]"); if (tr) abrirCotizacion(+tr.dataset.id); });

let actual = null;
async function abrirCotizacion(id) {
  try { actual = await api(`/api/cotizaciones/${id}`); } catch (e) { return toast("⚠️ " + esc(e.message)); }
  const c = actual;
  $("#mc-num").textContent = `${num(c.id)} · ${c.estado}`;
  $("#mc-veh").textContent = c.vehiculo;
  $("#mc-meta").textContent = `${kmf(c.km)} · ${fecha(c.fecha)} · ${c.asesor || c.usuario}` + (c.actualizada && c.actualizada !== c.fecha ? ` · editada ${fecha(c.actualizada)}` : "");
  $("#mc-mercado").textContent = usd(c.mercado);
  $("#mc-oferta").textContent = `${usd(c.oferta)} (${(c.margen * 100).toFixed(1)}%)`;
  $("#mc-conf").textContent = c.confianza ? c.confianza[0].toUpperCase() + c.confianza.slice(1) : "–";
  const f = $("#f-mc");
  ["cliente", "telefono", "correo", "placa", "color", "notas", "estado", "oferta_final"].forEach(k => f.elements[k].value = c[k] ?? "");
  error($("#mc-err"), "");
  $("#mc-inventario").hidden = c.estado !== "Comprada";
  $("#m-cot").hidden = false;
}

$("#f-mc").addEventListener("submit", async e => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  d.oferta_final = +d.oferta_final || null;
  try {
    actual = await api(`/api/cotizaciones/${actual.id}`, d);
    $("#m-cot").hidden = true; toast(`${num(actual.id)} actualizada`);
    if (!$('[data-vista="historial"]').hidden) cargarHistorial();
  } catch (err) { error($("#mc-err"), err.message); }
});
$("#mc-imprimir").addEventListener("click", () => {
  const d = Object.fromEntries(new FormData($("#f-mc")));
  imprimir({ ...actual, ...d, oferta_final: +d.oferta_final || actual.oferta_final });
});
$("#mc-recotizar").addEventListener("click", () => {
  const c = actual;
  $("#m-cot").hidden = true;
  location.hash = "#/nueva";
  cargarEntrada(c.datos.entrada);
  const f = $("#f-cliente");
  ["cliente", "telefono", "correo", "placa", "color"].forEach(k => f.elements[k].value = c[k] ?? "");
  toast(`Recotizando ${num(c.id)} con el mercado de hoy. Se guardará como una cotización nueva.`, 5000);
});

// ================================================================== RESUMEN
$("#r-dias").addEventListener("change", cargarResumen);

async function cargarResumen() {
  pintarModelo();
  let r;
  try { r = await api("/api/resumen?dias=" + $("#r-dias").value); } catch (e) { return toast("⚠️ " + esc(e.message)); }
  $("#res-alcance").textContent = YO.rol === "admin" ? "Todo el equipo" : "Solo tus cotizaciones";
  $("#kpis").innerHTML = [
    ["Cotizaciones", r.total, `en ${r.dias} días`],
    ["Compradas", r.compradas, r.tasa == null ? "sin cierres todavía" : `${(r.tasa * 100).toFixed(0)}% de las cerradas`],
    ["Valor comprado", usd(r.valor_comprado), "suma de ofertas finales"],
    ["Compra vs mercado", r.descuento_prom == null ? "–" : pct(r.descuento_prom, 1), "promedio en carros comprados"],
  ].map(([t, v, s]) => `<div class="kpi"><small>${t}</small><b>${v}</b><span>${s}</span></div>`).join("");

  const pasoDias = r.dias > 60 ? 7 : 1, dias = [];
  for (let i = 0; i < r.por_dia.length; i += pasoDias) {
    const g = r.por_dia.slice(i, i + pasoDias);
    dias.push({ dia: g[0].dia, n: g.reduce((a, b) => a + b.n, 0) });
  }
  grafico("ch-dia", { type: "bar", data: { labels: dias.map(d => new Date(d.dia + "T12:00").toLocaleDateString("es-EC", { day: "2-digit", month: "short" })),
      datasets: [{ data: dias.map(d => d.n), backgroundColor: C.pri, borderRadius: 4, maxBarThickness: 26 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false },
        tooltip: { backgroundColor: C.deep, displayColors: false, callbacks: { label: it => `${it.parsed.y} cotizaciones` + (pasoDias > 1 ? " (semana)" : "") } } },
      scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } }, y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: C.line } } } } });

  const barras = (items, max) => items.map(([t, n, color]) => `<div class="barra"><span>${t}</span><b>${n}</b>
      <div class="barra-t"><i style="width:${max ? (n / max) * 100 : 0}%;${color ? "background:" + color : ""}"></i></div></div>`).join("");
  const colores = { "Cotizada": C.pri, "En negociación": "#F59E0B", "Comprada": "#10B981", "Perdida": "#9CA3AF" };
  $("#r-estados").innerHTML = barras(ESTADOS.map(e => [pill(e), r.por_estado[e], colores[e]]), Math.max(...Object.values(r.por_estado), 1));
  $("#r-modelos").innerHTML = r.top_modelos.length ? barras(r.top_modelos.map(m => [esc(m.vehiculo), m.n]), r.top_modelos[0].n) : `<p class="hint">Sin datos todavía.</p>`;
  $("#r-asesores").innerHTML = r.por_asesor.length ? r.por_asesor.map(a => `<tr><td>${esc(a.asesor)}</td><td class="num">${a.n}</td><td class="num">${a.compradas}</td><td class="num">${usd(a.valor)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="vacio-tabla">Sin cotizaciones en este periodo.</td></tr>`;
}

function pintarModelo() {
  const m = CAT.metricas;
  $("#metricas").innerHTML = [
    [m.con_pn.R2.toFixed(2), "R² con precio de nuevo"],
    [m.afinado["MdAPE %"].toFixed(1) + "%", "error mediano en carros nunca vistos"],
    [m.afinado["±15 %"].toFixed(0) + "%", "de estimaciones a menos de ±15%"],
    [CAT.n_avisos.toLocaleString("es-EC"), "avisos de mercado analizados"],
  ].map(([b, s]) => `<div class="met"><b>${b}</b><span>${s}</span></div>`).join("");
  $("#lujo-txt").innerHTML = `Bajo ${usd(CAT.limite_confiable)} el error típico es ±${m.bajo_60k["MdAPE %"].toFixed(1)}%. ` +
    `Sobre ese valor (lujo, deportivos, exóticos) hay pocos avisos y sube a ±${m.sobre_60k["MdAPE %"].toFixed(1)}% (R² ${m.sobre_60k.R2.toFixed(2)}): ` +
    `en esos carros el indicador de confianza aparece en rojo y conviene una tasación manual. Los valores se basan en precios publicados, no en ventas cerradas.`;
}

// ================================================================== USUARIOS
async function cargarUsuarios() {
  try {
    const us = await api("/api/usuarios");
    $("#u-tabla").innerHTML = us.map(u => `<tr data-u="${esc(u.usuario)}">
      <td><b>${esc(u.nombre)}</b></td><td>${esc(u.usuario)}</td>
      <td><select class="u-rol" ${u.usuario === YO.usuario ? "disabled" : ""}><option value="asesor" ${u.rol === "asesor" ? "selected" : ""}>Asesor</option><option value="admin" ${u.rol === "admin" ? "selected" : ""}>Administrador</option></select></td>
      <td>${u.activo ? pill("Activo") : `<span class="pill e-Perdida">Desactivado</span>`}</td>
      <td class="num">
        <button class="btn btn-ghost btn-mini u-clave">Nueva contraseña</button>
        ${u.usuario === YO.usuario ? "" : `<button class="btn btn-ghost btn-mini u-activo">${u.activo ? "Desactivar" : "Activar"}</button>`}
      </td></tr>`).join("");
  } catch (e) { toast("⚠️ " + esc(e.message)); }
}

$("#u-tabla").addEventListener("click", async e => {
  const tr = e.target.closest("tr[data-u]"); if (!tr) return;
  const u = tr.dataset.u;
  try {
    if (e.target.closest(".u-clave")) {
      const clave = prompt(`Nueva contraseña para ${u} (mínimo 6 caracteres):`);
      if (!clave) return;
      await api(`/api/usuarios/${encodeURIComponent(u)}`, { clave });
      toast(`Contraseña de ${esc(u)} cambiada`);
    } else if (e.target.closest(".u-activo")) {
      const activar = e.target.textContent.trim() === "Activar";
      if (!activar && !confirm(`¿Desactivar a ${u}? Ya no podrá ingresar (sus cotizaciones se conservan).`)) return;
      await api(`/api/usuarios/${encodeURIComponent(u)}`, { activo: activar });
      cargarUsuarios();
    }
  } catch (err) { toast("⚠️ " + esc(err.message)); }
});
$("#u-tabla").addEventListener("change", async e => {
  if (!e.target.classList.contains("u-rol")) return;
  const u = e.target.closest("tr").dataset.u;
  try { await api(`/api/usuarios/${encodeURIComponent(u)}`, { rol: e.target.value }); toast(`Rol de ${esc(u)} actualizado`); }
  catch (err) { toast("⚠️ " + esc(err.message)); cargarUsuarios(); }
});

$("#f-usuario").addEventListener("submit", async e => {
  e.preventDefault();
  error($("#usr-err"), "");
  try {
    const u = await api("/api/usuarios", Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    toast(`Usuario <b>${esc(u.usuario)}</b> creado. Pásale su contraseña inicial.`);
    $("#h-asesor").innerHTML = `<option value="">Todos los asesores</option>`;   // se recarga al volver al historial
    cargarUsuarios();
  } catch (err) { error($("#usr-err"), err.message); }
});

// ================================================================== INVENTARIO Y PRECIO DINÁMICO
const usdE = v => v == null || isNaN(v) ? "–" : (v < 0 ? "-$" : "$") + Math.abs(Math.round(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");   // 18.950
const diaF = iso => new Date(String(iso).slice(0, 10) + "T12:00").toLocaleDateString("es-EC", { day: "2-digit", month: "short", year: "numeric" });
const SEM = { verde: "En orden", amarillo: "Atención", rojo: "Crítico" };
const COL_SEM = { verde: "#10B981", amarillo: "#F59E0B", rojo: "#EF4444" };
const semDot = s => `<span class="sem ${s || ""}" title="${s ? SEM[s] : ""}"></span>`;
const recPill = r => r ? `<span class="pill r-${r}">${r}</span>` : "";
const estPill = e => `<span class="pill e-${e.replace(/ /g, "-")}">${esc(e)}</span>`;
const vendida = u => ["Vendida", "Liquidada"].includes(u.estado);
const pctE = (v, d = 0) => v == null ? "–" : (v >= 0 ? "+" : "") + (v * 100).toFixed(d).replace(".", ",") + " %";
const nombreVeh = u => u.vehiculo || `${u.marca} ${u.familia} ${u.anio}`;
const usd2E = v => v == null || isNaN(v) ? "–" : "$" + Number(v).toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d),)/g, ".");   // 25,15
const confPill = c => c ? `<span class="pill c-${c.nivel}" title="${esc(c.texto)}">${c.nivel[0].toUpperCase() + c.nivel.slice(1)}</span>` : "";
const ORDEN_CONF = { baja: 0, media: 1, alta: 2 };
const FUENTE_TXT = { empresa: "Dato de la empresa", supuesto: "Supuesto — reemplazar con dato de 1001Carros", manual: "Valor propio" };
const tagFuente = f => `<span class="tag-fuente ${f}">${FUENTE_TXT[f]}</span>`;
const hoyISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);

// ------------------------------------------------------------------ lista
let inv = { filas: [], orden: { k: "sem", dir: 1 } };
let iTimer = null;
["#i-texto", "#i-estado", "#i-linea", "#i-agencia", "#i-sem"].forEach(s => $(s).addEventListener("input", () => { clearTimeout(iTimer); iTimer = setTimeout(cargarInventario, 250); }));

async function cargarInventario() {
  const est = $("#i-estado").value;
  const qs = new URLSearchParams({ texto: $("#i-texto").value, linea: $("#i-linea").value, agencia: $("#i-agencia").value,
    semaforo: $("#i-sem").value, estado: ["activas", "todas"].includes(est) ? "" : est });
  $("#inv-sub").textContent = "Calculando precios con el modelo…";
  try {
    const r = await api("/api/inventario?" + qs);
    const ag = $("#i-agencia"), sel = ag.value;
    ag.innerHTML = `<option value="">Todas las agencias</option>` + r.agencias.map(a => `<option>${esc(a)}</option>`).join("");
    ag.value = sel;
    $("#lista-agencias").innerHTML = r.agencias.map(a => `<option value="${esc(a)}">`).join("");
    inv.filas = r.unidades.filter(u => est !== "activas" || !vendida(u));
    pintarInventario();
  } catch (e) { $("#inv-sub").textContent = ""; toast("⚠️ " + esc(e.message)); }
}

const ORDEN_SEM = { rojo: 0, amarillo: 1, verde: 2 };
function valorOrden(u, k) {
  if (k === "sem") return u.semaforo == null ? 9 : ORDEN_SEM[u.semaforo];
  if (k === "vehiculo") return nombreVeh(u).toLowerCase();
  if (k === "linea") return (u.linea + (u.agencia || "")).toLowerCase();
  if (k === "conf") return u.confianza ? ORDEN_CONF[u.confianza.nivel] : null;
  return u[k] ?? null;
}

function pintarInventario() {
  const { k, dir } = inv.orden;
  const filas = inv.filas.slice().sort((a, b) => {
    const x = valorOrden(a, k), y = valorOrden(b, k);
    if (x == null) return 1; if (y == null) return -1;      // los vacíos siempre al final
    return (x < y ? -1 : x > y ? 1 : 0) * dir || b.dias - a.dias;
  });
  $$("#i-tabla th[data-k]").forEach(th => { th.classList.toggle("asc", th.dataset.k === k && dir === 1); th.classList.toggle("desc", th.dataset.k === k && dir === -1); });
  const rojas = filas.filter(u => u.semaforo === "rojo").length;
  $("#inv-sub").textContent = `${filas.length} unidad${filas.length === 1 ? "" : "es"}` + (rojas ? ` · ${rojas} en rojo` : "");
  $("#i-vacio").hidden = filas.length > 0;
  $("#i-tabla tbody").innerHTML = filas.map(u => {
    if (vendida(u)) return `<tr class="clic" data-id="${u.id}"><td>${semDot(null)}</td>
      <td><b>${esc(nombreVeh(u))}</b><small>${esc(u.placa || "")}${u.placa ? " · " : ""}${kmf(u.km)}</small></td>
      <td>${esc(u.linea)}<small>${esc(u.agencia || "–")}</small></td><td class="num">${u.dias}</td>
      <td class="num">${usdE(u.costo_acumulado)}</td><td class="num">${usdE(u.precio_publicado)}</td><td class="num">–</td><td>–</td><td class="num">–</td>
      <td class="num"><b>${usdE(u.precio_venta)}</b></td>
      <td>${estPill(u.estado)}<small>Utilidad real ${usdE(u.utilidad)}</small></td><td class="num">–</td></tr>`;
    const eq = u.dias_hasta_equilibrio == null ? "Sin riesgo"
      : u.dias_hasta_equilibrio <= 0 ? `<span class="down">Hace ${-u.dias_hasta_equilibrio} d</span>` : `en ${u.dias_hasta_equilibrio} d`;
    return `<tr class="clic" data-id="${u.id}"><td>${semDot(u.semaforo)}</td>
      <td><b>${esc(nombreVeh(u))}</b><small>${esc(u.placa || "")}${u.placa ? " · " : ""}${kmf(u.km)}${u.estado === "Reservada" ? " · Reservada" : ""}</small></td>
      <td>${esc(u.linea)}<small>${esc(u.agencia || "–")}</small></td>
      <td class="num nw"><b>${u.dias}</b>${u.revision_vencida ? `<small class="down">revisión vencida</small>` : ""}</td>
      <td class="num">${usdE(u.costo_acumulado)}</td><td class="num"><b>${usdE(u.precio_publicado)}</b></td>
      <td class="num">${usdE(u.mercado)}${u.referencia_manual ? `<small><span class="tag-ref" title="${esc(u.fuente_mercado_manual)}">Ref. manual</span></small>` : ""}</td>
      <td>${confPill(u.confianza)}</td><td class="num ${u.pct_vs_mercado > .03 ? "down" : u.pct_vs_mercado < -.03 ? "up" : ""}">${pctE(u.pct_vs_mercado)}</td>
      <td class="num"><b>${usdE(u.sugerido)}</b></td>
      <td>${recPill(u.recomendacion)}<small class="rec-txt">${esc(u.texto)}</small></td><td class="num nw">${eq}</td></tr>`;
  }).join("");
}

$("#i-tabla thead").addEventListener("click", e => {
  const th = e.target.closest("th[data-k]"); if (!th) return;
  inv.orden = { k: th.dataset.k, dir: inv.orden.k === th.dataset.k ? -inv.orden.dir : 1 };
  pintarInventario();
});
$("#i-tabla tbody").addEventListener("click", e => { const tr = e.target.closest("tr[data-id]"); if (tr) location.hash = "#/unidad/" + tr.dataset.id; });

// ------------------------------------------------------------------ nueva unidad (manual o desde una cotización comprada)
let nu = null;      // { marca, familia, version, cotizacion }
function armarNuevaUnidad() {
  const marcas = Object.keys(CAT.marcas).sort((a, b) => CAT.marcas[b].n - CAT.marcas[a].n);
  combo($("#cb-u-marca"), () => marcas.map(m => ({ id: m, txt: m, n: CAT.marcas[m].n })), it => uMarca(it.id));
  combo($("#cb-u-modelo"), () => nu.marca ? CAT.marcas[nu.marca].modelos.map(f => ({ id: f.id, txt: f.nombre, n: f.n })) : [], it => uModelo(it.id));
  $("#u-version").addEventListener("change", e => { nu.version = e.target.value || null; });
}
function uMarca(m) {
  nu.marca = m; nu.familia = null; nu.version = null;
  $("#cb-u-marca input").value = m;
  const mi = $("#cb-u-modelo input"); mi.disabled = false; mi.value = ""; mi.placeholder = `Modelos de ${m}…`;
  $("#u-version").disabled = true; $("#u-version").innerHTML = `<option value="">No sé / estándar</option>`;
}
function uModelo(id, version = null) {
  const f = CAT.marcas[nu.marca].modelos.find(x => x.id === id); if (!f) return;
  nu.familia = id; nu.version = version;
  $("#cb-u-modelo input").value = f.nombre;
  const sv = $("#u-version");
  sv.innerHTML = `<option value="">No sé / estándar</option>` + f.versiones.map(v => `<option value="${esc(v.id)}">${esc(v.nombre)}</option>`).join("");
  sv.disabled = !f.versiones.length; sv.value = version || "";
}

function abrirNuevaUnidad(cot) {
  const f = $("#f-unidad"); f.reset();
  nu = { marca: null, familia: null, version: null, cotizacion: cot || null };
  $("#cb-u-marca input").value = ""; $("#cb-u-modelo input").value = ""; $("#cb-u-modelo input").disabled = true;
  $("#u-version").disabled = true; $("#u-version").innerHTML = `<option value="">No sé / estándar</option>`;
  f.elements.fecha_ingreso.value = hoyISO();
  $("#nu-tit").textContent = cot ? `Pasar ${num(cot.id)} a inventario` : "Nueva unidad";
  $("#nu-sub").textContent = cot ? "Se precargó el auto y la oferta final como costo de compra. Define el precio de publicación." : "Registra un carro que está en el patio.";
  if (cot) {
    const e = cot.datos.entrada;
    if (CAT.marcas[e.marca]) { uMarca(e.marca); uModelo(e.familia, e.version); }
    f.elements.anio.value = e.anio; f.elements.km.value = e.km ?? "";
    f.elements.costo_compra.value = cot.oferta_final; f.elements.placa.value = cot.placa || ""; f.elements.color.value = cot.color || "";
    f.elements.precio_publicado.value = Math.round(cot.mercado / 100) * 100;
  }
  error($("#nu-err"), "");
  $("#m-unidad").hidden = false;
}
$("#btn-nueva-unidad").addEventListener("click", () => abrirNuevaUnidad(null));
$("#mc-inventario").addEventListener("click", () => { $("#m-cot").hidden = true; abrirNuevaUnidad(actual); });

$("#f-unidad").addEventListener("submit", async e => {
  e.preventDefault();
  if (!nu.familia) return error($("#nu-err"), "Elige la marca y el modelo de la lista");
  const d = Object.fromEntries([...new FormData(e.target)].filter(([, v]) => v !== ""));
  const body = { ...d, marca: nu.marca, familia: nu.familia, version: nu.version };
  if (nu.cotizacion) body.cotizacion_id = nu.cotizacion.id;
  try {
    const r = await api("/api/inventario", body);
    $("#m-unidad").hidden = true;
    toast(`${esc(nombreVeh(r.unidad))} agregada al inventario`);
    location.hash = "#/unidad/" + r.unidad.id;
  } catch (err) { error($("#nu-err"), err.message); }
});

// ------------------------------------------------------------------ detalle de unidad
let det = null;
async function cargarUnidad(id) {
  try { det = await api("/api/inventario/" + id); }
  catch (e) { toast("⚠️ " + esc(e.message)); location.hash = "#/inventario"; return; }
  pintarUnidad();
}

function pintarUnidad() {
  const { unidad: u, evaluacion: e } = det, v = vendida(u);
  $("#un-tit").textContent = nombreVeh(u);
  $("#un-meta").innerHTML = `${estPill(u.estado)} ${esc(u.linea)} · ${esc(u.agencia || "sin agencia")} · ${kmf(u.km)}${u.placa ? " · " + esc(u.placa) : ""}${u.color ? " · " + esc(u.color) : ""} · ingresó el ${diaF(u.fecha_ingreso)}`;
  $("#un-activa").hidden = v; $("#un-vendida").hidden = !v;
  $("#un-historial").innerHTML = det.historial.map(h => `<tr><td class="nw">${fechaCorta(h.fecha)}</td>
    <td class="num">${usdE(h.precio_anterior)}</td><td class="num"><b>${usdE(h.precio_nuevo)}</b></td><td class="num">${usdE(h.precio_sugerido)}</td>
    <td>${esc(h.motivo || "–")}</td><td>${esc(h.nombre_usuario || h.usuario || "–")}</td></tr>`).join("");
  pintarCostoMercado(v);
  if (v) {
    const dif = u.precio_venta - u.precio_publicado;
    $("#un-vendida").innerHTML = `<h3 class="card-tit">${esc(u.estado)} el ${diaF(u.fecha_venta)}</h3><div class="vend-grid">
      <div><small>Precio de venta</small><b>${usdE(u.precio_venta)}</b></div><div><small>Días en piso</small><b>${e.dias}</b></div>
      <div><small>Costo acumulado a la venta</small><b>${usdE(e.costo_acumulado)}</b></div>
      <div><small>Utilidad real</small><b class="${e.utilidad >= 0 ? "up" : "down"}">${usdE(e.utilidad)}</b></div></div>
      <p class="hint">Último precio publicado: ${usdE(u.precio_publicado)} (${dif >= 0 ? "vendió " + usdE(dif) + " sobre" : "descuento de " + usdE(-dif) + " frente a"} lo publicado).</p>`;
    return;
  }
  $("#un-sugerido").textContent = usdE(e.sugerido);
  $("#un-rec").innerHTML = recPill(e.recomendacion);
  $("#un-sem").innerHTML = `${semDot(e.semaforo)} <small>${SEM[e.semaforo]}</small>`;
  $("#un-texto").textContent = e.texto;
  const igual = Math.abs(e.sugerido - u.precio_publicado) < 1;
  $("#un-aplicar").textContent = igual ? "Confirmar revisión (mantener)" : `Aplicar sugerido ${usdE(e.sugerido)}`;
  const eq = e.dia_equilibrio == null ? ["Sin riesgo", "el mercado cubre el costo en los próximos meses", "bien"]
    : e.dias_hasta_equilibrio <= 0 ? [`Día ${e.dia_equilibrio}`, `ya pasó (${diaF(e.fecha_equilibrio)}): deja de ganar plata`, "mal"]
    : [`Día ${e.dia_equilibrio}`, `${diaF(e.fecha_equilibrio)} · deja de ganar plata (en ${e.dias_hasta_equilibrio} d)`, ""];
  const datos = [
    ["Días en piso", e.dias, `tramo ${e.tramo_nombre} días` + (e.revision_vencida ? " · revisión vencida" : ""), e.revision_vencida ? "mal" : ""],
    ["Precio publicado", usdE(u.precio_publicado), `${pctE(e.pct_vs_mercado)} vs mercado`, ""],
    [e.referencia_manual ? "Mercado (referencia manual)" : "Valor de mercado", usdE(e.mercado), `rango ${usdE(e.bajo50)} – ${usdE(e.alto50)}`, ""],
    ["Confianza del mercado", e.confianza.nivel[0].toUpperCase() + e.confianza.nivel.slice(1), e.referencia_manual ? "cubierta con referencia manual" : `${e.confianza.n_modelo} avisos de la familia`, e.confianza.nivel === "baja" && !e.referencia_manual ? "mal" : e.confianza.nivel === "alta" ? "bien" : ""],
    ["Costo acumulado (piso)", usdE(e.costo_acumulado), `${usd2E(e.costo_diario)} por día`, ""],
    ["Utilidad si vende hoy", usdE(e.utilidad_publicado), `al sugerido: ${usdE(e.utilidad_sugerido)}`, e.utilidad_publicado >= 0 ? "bien" : "mal"],
    ["Punto de equilibrio", eq[0], eq[1], eq[2]],
    ["Competencia", e.n_comparables ?? "–", "avisos parecidos en Patio Tuerca", ""],
  ];
  $("#un-datos").innerHTML = datos.map(([t, b, s, c]) => `<div class="${c}"><small>${t}</small><b>${b}</b><span>${s}</span></div>`).join("");
  pintarGraficoUnidad();
}

// costo diario (desglose), confianza del mercado, referencia manual y comparables
function pintarCostoMercado(v) {
  const { unidad: u, evaluacion: e, desglose: g } = det;
  $("#un-costo-sub").textContent = g.total_manual
    ? "Esta unidad tiene un costo diario propio que reemplaza el cálculo por parámetros."
    : "Capital y seguro dependen de lo invertido en este carro; patio y lavado son fijos por día.";
  $("#un-costo-filas").innerHTML = g.componentes.map(c => `<tr class="${g.total_manual ? "tachada" : ""}"><td><b>${esc(c.nombre)}</b> ${tagFuente(c.fuente)}
    <div class="cuenta">${esc(c.nombre)}: ${esc(c.formula)}</div></td><td class="num nw"><b>${usd2E(c.valor)}</b></td></tr>`).join("");
  $("#un-costo-total").innerHTML = `<div><small>Costo diario total</small><b>${usd2E(g.total_diario)}</b><span>${g.total_manual ? "valor propio de la unidad" : g.componentes.map(c => usd2E(c.valor)).join(" + ")}</span></div>
    <div><small>Acumulado a ${v ? "la venta" : "hoy"} (día ${g.dias})</small><b>${usdE(g.acumulado)}</b><span>${esc(g.formula_acumulado).replace(/USD /g, "$")}</span></div>`;
  $("#un-mercado").hidden = v; $("#un-comps-card").hidden = v;
  $("#un-refs-card").hidden = !det.referencias.length;
  $("#un-refs").innerHTML = det.referencias.map(r => `<tr><td class="nw">${fechaCorta(r.fecha)}</td>
    <td class="num"><b>${r.valor == null ? "Retirada" : usdE(r.valor)}</b></td><td class="num">${usdE(r.valor_modelo)}</td>
    <td>${esc(r.fuente || "–")}</td><td>${esc(r.nombre_usuario || r.usuario || "–")}</td></tr>`).join("");
  if (v) return;
  const c = e.confianza;
  $("#un-conf").innerHTML = `<div class="conf-caja ${c.nivel}"><b>${confPill(c)} &nbsp;${c.ancho ? "Rango probable ±" + c.ancho.toFixed(0) + " %" : ""}</b>${esc(c.texto)}</div>`;
  const man = e.referencia_manual;
  $("#un-ref").innerHTML = man
    ? `<div class="fuerte"><small>Mercado: referencia manual</small><b>${usdE(u.mercado_manual)}</b><span>${esc(u.fuente_mercado_manual)} · ${esc(u.usuario_mercado_manual || "")} · ${diaF(u.fecha_mercado_manual)}</span></div>
       <div><small>Valor del modelo hoy</small><b>${usdE(e.mercado_modelo)}</b><span>${pctE(e.mercado / e.mercado_modelo - 1, 0)} la referencia frente al modelo</span></div>`
    : `<div class="fuerte"><small>Mercado: modelo XGBoost</small><b>${usdE(e.mercado)}</b><span>rango ${usdE(e.bajo50)} – ${usdE(e.alto50)}</span></div>
       <div><small>Precio de nuevo</small><b>${u.pn_con_iva ? usdE(u.pn_con_iva) : "Sin dato"}</b><span>${u.pn_con_iva ? (u.pn_origen === "manual" ? "ingresado a mano" : u.pn_origen === "cotización" ? "viene de la cotización" : "detectado en el catálogo") : "el modelo trabaja sin este dato"}</span></div>`;
  $("#un-ref-btn").textContent = man ? "Cambiar o retirar la referencia…" : "Fijar referencia manual…";
  $("#un-comps-sub").textContent = det.comparables.length
    ? `Los ${det.comparables.length} avisos más parecidos de ${det.n_comparables} de la familia (año ±4, km similar). El valor de mercado de hoy es ${usdE(e.mercado)}${man ? " (referencia manual)" : ""}.`
    : "";
  $("#un-comps-vacio").hidden = det.comparables.length > 0;
  $("#un-comps").innerHTML = det.comparables.map(a => `<tr><td>${esc(a.titulo)}</td><td class="num">${a.anio}</td><td class="num">${a.km == null ? "–" : Math.round(a.km).toLocaleString("es-EC")}</td>
    <td class="num"><b>${usdE(a.precio)}</b></td><td class="num ${a.dif > .15 ? "down" : a.dif < -.15 ? "up" : ""}">${pctE(a.dif)}</td><td>${esc(a.ciudad || "–")}</td>
    <td>${a.url ? `<a class="enlace" href="${esc(a.url)}" target="_blank" rel="noopener">Ver aviso ↗</a>` : ""}</td></tr>`).join("");
}

const fondoTramos = {
  id: "fondoTramos",
  beforeDatasetsDraw(ch) {
    const o = ch.options.plugins.fondoTramos; if (!o) return;
    const { ctx, chartArea: a, scales: { x } } = ch;
    const lim = [0, ...o.limites], tint = ["rgba(16,185,129,.07)", "rgba(254,203,0,.10)", "rgba(245,158,11,.11)", "rgba(239,68,68,.07)", "rgba(239,68,68,.15)"];
    ctx.save(); ctx.textAlign = "center"; ctx.font = "600 11px Inter, sans-serif";
    lim.forEach((ini, i) => {
      const x0 = Math.max(x.getPixelForValue(ini), a.left), x1 = i < o.limites.length ? Math.min(x.getPixelForValue(lim[i + 1]), a.right) : a.right;
      if (x1 <= x0) return;
      ctx.fillStyle = tint[i]; ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top);
      ctx.fillStyle = "#6B7280"; ctx.fillText(o.nombres[i] + " d", (x0 + x1) / 2, a.top + 14);
    });
    ctx.restore();
  },
  afterDatasetsDraw(ch) {
    const o = ch.options.plugins.fondoTramos; if (!o || o.hoy == null) return;
    const { ctx, chartArea: a, scales: { x } } = ch, px = x.getPixelForValue(o.hoy);
    ctx.save(); ctx.strokeStyle = C.deep; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(px, a.top + 22); ctx.lineTo(px, a.bottom); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = C.deep; ctx.font = "700 11px Inter, sans-serif"; ctx.textAlign = px > a.right - 70 ? "right" : "left";
    ctx.fillText("Hoy · día " + o.hoy, px + (px > a.right - 70 ? -6 : 6), a.top + 36);
    ctx.restore();
  },
};

function pintarGraficoUnidad() {
  const { unidad: u, evaluacion: e, curvas: cv, historial: h, parametros: p } = det;
  const camb = h.slice().reverse().map((x, i) => ({ d: i === 0 ? 0 : Math.max(0, Math.round((new Date(x.fecha.slice(0, 10) + "T12:00") - new Date(u.fecha_ingreso + "T12:00")) / 864e5)), v: x.precio_nuevo }));
  const pub = d => camb.reduce((v, c) => c.d <= d ? c.v : v, camb[0] ? camb[0].v : u.precio_publicado);
  const pt = (k, f) => cv.map(r => ({ x: r.d, y: f ? f(r) : r[k] }));
  const eq = e.dia_equilibrio != null && e.dia_equilibrio <= cv[cv.length - 1].d ? cv[e.dia_equilibrio] : null;
  const linea = (label, data, color, extra = {}) => ({ label, data, borderColor: color, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 4, fill: false, ...extra });
  grafico("ch-unidad", {
    type: "line",
    plugins: [fondoTramos],
    data: { datasets: [
      { label: "Rango probable de mercado", data: pt("alto50"), borderWidth: 0, pointRadius: 0, fill: "+1", backgroundColor: C.lav },
      { label: "bajo50", data: pt("bajo50"), borderWidth: 0, pointRadius: 0, fill: false },
      linea(e.referencia_manual ? "Mercado (referencia manual)" : "Valor de mercado", pt("mercado"), C.pri, { borderWidth: 3, tension: .3 }),
      linea("Costo acumulado (piso)", pt("costo"), "#DC2626", { borderDash: [7, 4] }),
      linea("Precio sugerido", pt("sugerido"), "#D97706", { stepped: true }),
      linea("Precio publicado", pt("pub", r => pub(r.d)), "#111827", { stepped: true, borderWidth: 2.5, borderDash: [2, 3] }),
      { label: "Día de equilibrio", type: "scatter", data: eq ? [{ x: eq.d, y: eq.costo }] : [], pointStyle: "rectRot", pointRadius: 9, pointHoverRadius: 11, backgroundColor: "#DC2626", borderColor: "#fff", borderWidth: 2 },
      ...(e.referencia_manual ? [linea("Valor del modelo (sin referencia)", pt("modelo"), "#818CF8", { borderWidth: 1.8, borderDash: [3, 3], tension: .3 })] : []),
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      interaction: { mode: "index", intersect: false, axis: "x" },
      plugins: {
        fondoTramos: { limites: p.tramos, nombres: det.tramos, hoy: e.dias },
        legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8, filter: i => i.text !== "bajo50" } },
        tooltip: { backgroundColor: C.deep, padding: 10, filter: it => it.datasetIndex >= 2 && it.datasetIndex <= 5,
          callbacks: { title: it => `Día ${it[0].parsed.x} · ${diaF(new Date(new Date(u.fecha_ingreso + "T12:00").getTime() + it[0].parsed.x * 864e5).toISOString())}`,
                       label: it => `${it.dataset.label}: ${usdE(it.parsed.y)}` } },
      },
      scales: { x: { type: "linear", min: 0, max: cv[cv.length - 1].d, title: { display: true, text: "Días en piso" }, grid: { display: false } },
                y: { grid: { color: C.line }, ticks: { callback: v => usdE(v) } } },
    },
  });
}

$("#un-aplicar").addEventListener("click", async () => {
  const b = $("#un-aplicar"); b.disabled = true;
  try {
    det = await api(`/api/inventario/${det.unidad.id}/precio`, { aplicar_sugerido: true });
    pintarUnidad(); toast(`Precio de revisión registrado: ${usdE(det.unidad.precio_publicado)}`);
  } catch (err) { toast("⚠️ " + esc(err.message)); }
  finally { b.disabled = false; }
});

function avisoPrecio() {
  const e = det.evaluacion, f = $("#f-precio"), nuevo = +f.elements.precio.value, tol = det.parametros.tolerancia_excepcion;
  const lejos = nuevo > 0 && Math.abs(nuevo / e.sugerido - 1) > tol;
  $("#pr-aviso").innerHTML = nuevo > 0 ? `${pctE(nuevo / e.sugerido - 1, 1)} frente al sugerido.` + (lejos ? ` <b>Excepción para el comité: escribe el motivo.</b>` : "") : "";
  f.elements.motivo.required = lejos;
}
$("#un-otro").addEventListener("click", () => {
  const e = det.evaluacion, f = $("#f-precio"); f.reset();
  $("#pr-sug").innerHTML = `Sugerido: <b>${usdE(e.sugerido)}</b> · publicado hoy: ${usdE(det.unidad.precio_publicado)}. Se permite hasta ±${(det.parametros.tolerancia_excepcion * 100).toFixed(0)} % sin justificar.`;
  f.elements.precio.value = Math.round(e.sugerido); error($("#pr-err"), ""); avisoPrecio();
  $("#m-precio").hidden = false;
});
$("#f-precio").elements.precio.addEventListener("input", avisoPrecio);
$("#f-precio").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    det = await api(`/api/inventario/${det.unidad.id}/precio`, { precio: +e.target.elements.precio.value, motivo: e.target.elements.motivo.value });
    $("#m-precio").hidden = true; pintarUnidad(); toast(`Precio actualizado a ${usdE(det.unidad.precio_publicado)}`);
  } catch (err) { error($("#pr-err"), err.message); }
});

function camposVenta() { $("#vt-campos").hidden = !["Vendida", "Liquidada"].includes($("#f-venta").elements.estado_inv.value); }
$("#f-venta").elements.estado_inv.addEventListener("change", camposVenta);
$("#un-vender").addEventListener("click", () => {
  const f = $("#f-venta"), u = det.unidad; f.reset();
  f.elements.estado_inv.value = vendida(u) ? u.estado : "Vendida";
  f.elements.fecha_venta.value = u.fecha_venta || hoyISO();
  f.elements.precio_venta.value = Math.round(u.precio_venta || u.precio_publicado);
  error($("#vt-err"), ""); camposVenta(); $("#m-venta").hidden = false;
});
$("#f-venta").addEventListener("submit", async e => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target)); d.estado = d.estado_inv; delete d.estado_inv;
  if (!["Vendida", "Liquidada"].includes(d.estado)) { delete d.fecha_venta; delete d.precio_venta; }
  try {
    det = await api(`/api/inventario/${det.unidad.id}`, d);
    $("#m-venta").hidden = true; pintarUnidad(); toast("Estado actualizado: " + esc(det.unidad.estado));
  } catch (err) { error($("#vt-err"), err.message); }
});

// ------------------------------------------------------------------ editar datos y referencia manual de la unidad
const CAMPOS_ED = ["pn_con_iva", "mercado_manual", "fuente_mercado_manual", "costo_compra", "reacondicionamiento", "costo_diario_manual",
  "costo_capital_manual", "costo_seguro_manual", "costo_espacio_manual", "costo_lavado_manual", "linea", "agencia", "placa"];
let edOrig = {};
function abrirEditar(enfocarReferencia) {
  const u = det.unidad, f = $("#f-editar"), e = det.evaluacion; f.reset();
  CAMPOS_ED.forEach(k => { f.elements[k].value = u[k] ?? ""; });
  edOrig = Object.fromEntries(CAMPOS_ED.map(k => [k, String(u[k] ?? "")]));
  $("#ed-sub").textContent = nombreVeh(u);
  $("#ed-pn-origen").textContent = u.pn_con_iva ? `(${u.pn_origen === "manual" ? "ingresado a mano" : u.pn_origen === "cotización" ? "de la cotización" : "detectado"})` : "(sin dato)";
  $("#ed-ref-hint").innerHTML = vendida(u) ? "" : `El modelo da hoy <b>${usdE(e.mercado_modelo)}</b> (${e.confianza.nivel === "baja" ? "confianza baja" : "confianza " + e.confianza.nivel}). `
    + `Con una referencia, el modelo solo aporta cuánto se deprecia por día; el nivel del precio lo pones tú. Queda registrado quién, cuándo, el valor y la fuente.`;
  error($("#ed-err"), "");
  $("#m-editar").hidden = false;
  if (enfocarReferencia) setTimeout(() => f.elements.mercado_manual.focus(), 50);
}
$("#un-editar").addEventListener("click", () => abrirEditar(false));
$("#un-ref-btn").addEventListener("click", () => abrirEditar(true));
$("#f-editar").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target.elements, body = {};
  CAMPOS_ED.forEach(k => { if (f[k].value !== edOrig[k]) body[k] = f[k].value; });
  // la referencia viaja junta (valor + fuente) solo si cambió alguna de las dos
  if ("fuente_mercado_manual" in body || "mercado_manual" in body) { body.mercado_manual = f.mercado_manual.value; body.fuente_mercado_manual = f.fuente_mercado_manual.value; }
  if (!Object.keys(body).length) { $("#m-editar").hidden = true; return; }
  try {
    det = await api(`/api/inventario/${det.unidad.id}`, body);
    $("#m-editar").hidden = true; pintarUnidad(); toast("Datos de la unidad actualizados");
  } catch (err) { error($("#ed-err"), err.message); }
});

// ------------------------------------------------------------------ tablero de objetivos
const fmtObj = (o, v) => v == null ? "–" : o.formato === "dias" ? v.toFixed(0) + " d" : o.formato === "usd" ? usdE(v) : (v * 100).toFixed(1).replace(".", ",") + " %";
const EST_OBJ = { ok: "Meta cumplida", cerca: "Cerca de la meta", lejos: "Lejos de la meta" };
async function cargarTablero() {
  let r;
  try { r = await api("/api/tablero"); } catch (e) { return toast("⚠️ " + esc(e.message)); }

  // A. ¿vamos a cumplir las metas?
  $("#t-obj").innerHTML = r.objetivos.map(o => {
    const av = o.avance, ancho = av == null ? 0 : Math.min(av, 1) * 100;
    return `<div class="obj-card ${o.estado || ""}"><h4>${esc(o.nombre)}</h4><div class="obj-valor">${fmtObj(o, o.valor)}</div>
      <div class="obj-meta">Meta: <b>${o.menos_es_mejor ? "≤ " : ""}${fmtObj(o, o.meta)}</b>${o.base != null ? ` · línea base ${fmtObj(o, o.base)}` : ""}${o.clave === "beneficio" ? " al año" : ""}</div>
      <div class="obj-barra"><i style="width:${ancho}%"></i></div>
      <div class="obj-avance">${av == null ? "Sin datos todavía" : `${EST_OBJ[o.estado]} · ${Math.round(av * 100)} %`}</div>
      <div class="obj-det">${esc(o.detalle)}</div></div>`;
  }).join("");

  // B. ¿qué hay que decidir esta semana?
  const d = r.decisiones;
  $("#t-pend").textContent = d.length ? `${d.length} ${d.length === 1 ? "decisión pendiente" : "decisiones pendientes"} esta semana` : "Sin decisiones pendientes esta semana";
  $("#t-sem").innerHTML = ["rojo", "amarillo", "verde"].map(s => `<span>${semDot(s)} ${r.semaforos[s]} ${SEM[s].toLowerCase()}</span>`).join("");
  $("#t-dec-vacio").hidden = d.length > 0; $("#t-dec-tabla").hidden = !d.length;
  $("#t-dec").innerHTML = d.map(x => `<tr class="clic" data-id="${x.id}"><td>${semDot(x.semaforo)}</td>
    <td><b>${esc(nombreVeh(x))}</b><small>${esc(x.linea)} · ${esc(x.agencia || "–")}</small></td><td class="num">${x.dias}</td>
    <td class="num">${usdE(x.precio_publicado)}</td><td class="num"><b>${usdE(x.sugerido)}</b></td>
    <td>${recPill(x.recomendacion)}<small class="rec-txt">${esc(x.texto)}</small></td>
    <td><ul class="motivos">${x.motivos.map(m => `<li>${esc(m)}</li>`).join("")}</ul></td>
    <td class="num"><div class="btns-dec"><button class="btn btn-pri btn-mini" data-aplicar="${x.id}">${x.igual ? "Confirmar revisión" : "Aplicar sugerido"}</button>
      <button class="btn btn-ghost btn-mini" data-mantener="${x.id}" data-nombre="${esc(nombreVeh(x))}" data-pub="${x.precio_publicado}" data-sug="${Math.round(x.sugerido)}">Mantener con motivo</button></div></td></tr>`).join("");

  // C. ¿dónde está el dinero?
  const m = r.dinero, antiguas = r.limite_antiguas;
  $("#t-kpis").innerHTML = [
    ["Capital inmovilizado", usdE(m.capital_inmovilizado), `${m.unidades} unidades en piso (compra + reacondicionamiento)`],
    ["Costo diario de tener el inventario", usdE(m.costo_diario_total), "capital + seguro + patio + lavado, todas las unidades"],
    [`Costo acumulado de las de más de ${antiguas} días`, usdE(m.costo_acumulado_mas_120), `${m.n_mas_120} unidad${m.n_mas_120 === 1 ? "" : "es"} que ya pasaron el límite`],
    ["Utilidad potencial", usdE(m.utilidad_potencial), "precio publicado − costo acumulado"],
    ["Días promedio de lo que hay en piso", m.dias_promedio == null ? "–" : m.dias_promedio.toFixed(0), "unidades en piso o reservadas"],
    ["Más de " + antiguas + " días", m.pct_mas_120 == null ? "–" : (m.pct_mas_120 * 100).toFixed(1).replace(".", ",") + " %", "de las unidades en piso"],
  ].map(([t, v, s]) => `<div class="kpi"><small>${t}</small><b>${v}</b><span>${s}</span></div>`).join("");
  const barra = (id, datos, colores, fmt) => grafico(id, { type: "bar", data: { labels: r.tramos.map(t => t + " d"), datasets: [{ data: datos, backgroundColor: colores, borderRadius: 6, maxBarThickness: 54 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false },
      tooltip: { backgroundColor: C.deep, displayColors: false, callbacks: { label: it => fmt(it.parsed.y) } } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0, callback: v => fmt(v) }, grid: { color: C.line } } } } });
  const col = ["#10B981", "#A3E635", "#F59E0B", "#F97316", "#EF4444"];
  barra("ch-tramos", r.tramos.map(t => m.por_tramo[t]), col, v => v + (v === 1 ? " unidad" : " unidades"));
  barra("ch-capital", r.tramos.map(t => m.capital_por_tramo[t]), col, v => usdE(v));

  // excepciones
  const pe = x => x.aprobado === 1 ? `<span class="pill a-si">Aprobada</span>` : x.aprobado === 0 ? `<span class="pill a-no">Rechazada</span>` : `<span class="pill a-pend">Pendiente</span>`;
  $("#t-exc-sub").textContent = `Cambios de precio de la semana que se alejaron más de ${(r.tolerancia_excepcion * 100).toFixed(0)} % del sugerido, más las que siguen sin aprobar. Una excepción sin aprobar cuenta como fuera de la regla.`;
  $("#t-exc-vacio").hidden = r.excepciones.length > 0;
  $("#t-exc").innerHTML = r.excepciones.map(x => { const dd = x.precio_nuevo / x.precio_sugerido - 1;
    return `<tr class="clic" data-id="${x.unidad_id}"><td class="nw">${fechaCorta(x.fecha)}</td><td>${esc(x.vehiculo || "–")}<small>${esc(x.placa || "")}</small></td>
    <td class="num">${usdE(x.precio_sugerido)}</td><td class="num"><b>${usdE(x.precio_nuevo)}</b></td><td class="num ${dd > 0 ? "up" : "down"}">${pctE(dd, 1)}</td>
    <td>${esc(x.motivo || "–")}</td><td>${esc(x.nombre_usuario || x.usuario)}</td>
    <td class="nw">${pe(x)}${YO.rol === "admin" && x.aprobado == null ? `<div class="btns-dec" style="margin-top:6px"><button class="btn btn-pri btn-mini" data-aprobar="${x.id}">Aprobar</button><button class="btn btn-ghost btn-mini" data-rechazar="${x.id}">Rechazar</button></div>` : ""}</td></tr>`; }).join("");
}

let mantener = null;
document.querySelector('[data-vista="tablero"]').addEventListener("click", async e => {
  const b = e.target.closest("[data-aplicar]"), mt = e.target.closest("[data-mantener]"), ap = e.target.closest("[data-aprobar],[data-rechazar]");
  if (b) {
    b.disabled = true;
    try { await api(`/api/inventario/${b.dataset.aplicar}/precio`, { aplicar_sugerido: true }); toast("Revisión registrada"); cargarTablero(); }
    catch (err) { toast("⚠️ " + esc(err.message)); b.disabled = false; }
    return;
  }
  if (mt) {
    mantener = mt.dataset.mantener; $("#f-mantener").reset(); error($("#mt-err"), "");
    $("#mt-sub").innerHTML = `<b>${mt.dataset.nombre}</b>: se mantiene en ${usdE(+mt.dataset.pub)} aunque el sugerido es ${usdE(+mt.dataset.sug)}. Queda como excepción para que el administrador la apruebe.`;
    $("#m-mantener").hidden = false; return;
  }
  if (ap) {
    ap.disabled = true;
    try { await api(`/api/precios/${ap.dataset.aprobar || ap.dataset.rechazar}/aprobar`, { aprobar: !!ap.dataset.aprobar }); toast(ap.dataset.aprobar ? "Excepción aprobada" : "Excepción rechazada"); cargarTablero(); }
    catch (err) { toast("⚠️ " + esc(err.message)); ap.disabled = false; }
    return;
  }
  const tr = e.target.closest("tr[data-id]"); if (tr) location.hash = "#/unidad/" + tr.dataset.id;
});
$("#f-mantener").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await api(`/api/inventario/${mantener}/precio`, { mantener: true, motivo: e.target.elements.motivo.value });
    $("#m-mantener").hidden = true; toast("Revisión registrada con su motivo"); cargarTablero();
  } catch (err) { error($("#mt-err"), err.message); }
});

// ------------------------------------------------------------------ parámetros (admin)
let paramDef = null;
const PARAM_COSTOS = ["tasa_capital_anual", "tasa_seguro_anual", "costo_espacio_diario", "costo_lavado_diario"];

// etiqueta "Supuesto — reemplazar con dato de 1001Carros" junto a cada costo + los dos ejemplos calculados en vivo
function pintarCostosEjemplo() {
  const f = $("#f-param").elements, n = k => (+f[k].value || 0);
  PARAM_COSTOS.forEach(k => { const t = $(`[data-tag="${k}"]`); t.className = "tag-fuente " + f["fuente_" + k].value; t.textContent = FUENTE_TXT[f["fuente_" + k].value]; });
  const filas = [["Capital", b => b * n("tasa_capital_anual") / 100 / 365, "tasa_capital_anual"], ["Seguro", b => b * n("tasa_seguro_anual") / 100 / 365, "tasa_seguro_anual"],
    ["Espacio en patio", () => n("costo_espacio_diario"), "costo_espacio_diario"], ["Lavado y mantenimiento", () => n("costo_lavado_diario"), "costo_lavado_diario"]];
  const bases = [17000, 76500];
  const tot = bases.map(b => filas.reduce((s, [, fn]) => s + fn(b), 0));
  $("#par-costos tbody").innerHTML = filas.map(([t, fn]) => `<tr><td>${t}</td>${bases.map(b => `<td class="num">${usd2E(fn(b))}</td>`).join("")}</tr>`).join("")
    + `<tr class="total"><td><b>Total por día</b></td>${tot.map(v => `<td class="num"><b>${usd2E(v)}</b></td>`).join("")}</tr>`
    + `<tr><td>A 90 días</td>${bases.map((b, i) => `<td class="num">${usdE(b + 90 * tot[i])}<small>costo acumulado</small></td>`).join("")}</tr>`;
}
$("#f-param").addEventListener("input", pintarCostosEjemplo);

function llenarParametros(p) {
  const f = $("#f-param").elements, t = p.tramos, a = p.ajustes;
  f.tasa_capital_anual.value = +(p.tasa_capital_anual * 100).toFixed(2); f.tasa_seguro_anual.value = +(p.tasa_seguro_anual * 100).toFixed(2);
  f.costo_espacio_diario.value = p.costo_espacio_diario; f.costo_lavado_diario.value = p.costo_lavado_diario;
  PARAM_COSTOS.forEach(k => { f["fuente_" + k].value = p.fuentes[k]; });
  f.piso_margen.value = +(p.piso_margen * 100).toFixed(2);
  f.base_dias_promedio.value = p.base_dias_promedio; f.meta_dias_promedio.value = p.meta_dias_promedio;
  f.base_pct_mas_120.value = +(p.base_pct_mas_120 * 100).toFixed(2); f.meta_pct_mas_120.value = +(p.meta_pct_mas_120 * 100).toFixed(2);
  f.meta_pct_en_regla.value = +(p.meta_pct_en_regla * 100).toFixed(2); f.meta_beneficio_anual.value = p.meta_beneficio_anual;
  pintarCostosEjemplo();
  t.forEach((x, i) => f["t" + i].value = x);
  [1, 2, 3, 4].forEach(i => f["a" + i].value = +(a[i] * 100).toFixed(2));
  f.dias_revision.value = p.dias_revision; f.tolerancia_banda.value = +(p.tolerancia_banda * 100).toFixed(2);
  f.tolerancia_excepcion.value = +(p.tolerancia_excepcion * 100).toFixed(2);
}
function leerParametros() {
  const f = $("#f-param").elements, n = k => +f[k].value;
  return { tasa_capital_anual: n("tasa_capital_anual") / 100, tasa_seguro_anual: n("tasa_seguro_anual") / 100,
    costo_espacio_diario: n("costo_espacio_diario"), costo_lavado_diario: n("costo_lavado_diario"),
    fuentes: Object.fromEntries(PARAM_COSTOS.map(k => [k, f["fuente_" + k].value])),
    base_dias_promedio: n("base_dias_promedio"), meta_dias_promedio: n("meta_dias_promedio"),
    base_pct_mas_120: n("base_pct_mas_120") / 100, meta_pct_mas_120: n("meta_pct_mas_120") / 100,
    meta_pct_en_regla: n("meta_pct_en_regla") / 100, meta_beneficio_anual: n("meta_beneficio_anual"),
    piso_margen: n("piso_margen") / 100, dias_revision: n("dias_revision"),
    tramos: [0, 1, 2, 3].map(i => n("t" + i)), ajustes: [0, n("a1") / 100, n("a2") / 100, n("a3") / 100, n("a4") / 100],
    tolerancia_banda: n("tolerancia_banda") / 100, tolerancia_excepcion: n("tolerancia_excepcion") / 100 };
}

async function cargarParametros() {
  error($("#par-err"), "");
  try {
    const [r, l] = await Promise.all([api("/api/parametros"), api("/api/inventario?estado=En piso")]);
    paramDef = r.por_defecto; llenarParametros(r.parametros);
    const sel = $("#par-unidad"), cur = sel.value;
    sel.innerHTML = l.unidades.map(u => `<option value="${u.id}">${esc(nombreVeh(u))} · ${u.dias} d</option>`).join("") || `<option value="">No hay unidades en piso</option>`;
    if (cur) sel.value = cur;
    $("#par-ejemplo").innerHTML = "";
  } catch (e) { toast("⚠️ " + esc(e.message)); }
}

async function simularParametros(guardar) {
  error($("#par-err"), "");
  const uid = $("#par-unidad").value;
  try {
    const r = await api("/api/parametros", { parametros: leerParametros(), guardar, unidad_id: uid ? +uid : undefined });
    if (guardar) { llenarParametros(r.parametros); toast("Parámetros guardados. Ya rigen para todo el inventario."); }
    if (uid) {
      const antes = (await api("/api/inventario/" + uid)).evaluacion, ahora = r.ejemplo;
      const fila = (t, f, fmt = usdE) => `<tr><td>${t}</td><td class="num">${fmt(antes[f])}</td><td class="num"><b>${fmt(ahora[f])}</b></td></tr>`;
      $("#par-ejemplo").innerHTML = fila("Costo acumulado", "costo_acumulado") + fila("Precio sugerido", "sugerido") +
        fila("Recomendación", "recomendacion", x => x) + fila("Utilidad al sugerido", "utilidad_sugerido") +
        fila("Día de equilibrio", "dia_equilibrio", x => x == null ? "–" : "día " + x) + fila("Semáforo", "semaforo", x => SEM[x]);
    }
  } catch (err) { error($("#par-err"), err.message); }
}
$("#f-param").addEventListener("submit", e => { e.preventDefault(); simularParametros(true); });
$("#par-simular").addEventListener("click", () => simularParametros(false));
$("#par-defecto").addEventListener("click", () => paramDef && llenarParametros(paramDef));
