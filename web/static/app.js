/* Pricing dinámico 1001 · lógica de la página. Habla con servidor.py (/api/...). */
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

let YO = null, CAT = null;
const charts = {};

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
  $("#login-tit").textContent = setup ? "Configuración inicial" : "Pricing dinámico 1001";
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
    armarNuevaUnidad();
    armarCalculadora();
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
const VISTAS = ["calculadora", "inventario", "tablero", "pruebas", "como", "parametros", "usuarios"];
window.addEventListener("hashchange", router);
function router() {
  if (!YO) return;
  let v = location.hash.replace("#/", "") || "calculadora", arg = null;
  if (v === "comite") v = "tablero";                 // el "Comité" pasó a llamarse Tablero de objetivos
  if (/^(unidad|calculadora)\/\d+$/.test(v)) { [, arg] = v.split("/"); v = "calculadora"; }     // #/unidad/ID (enlaces de la v4) abre la Calculadora
  if (!VISTAS.includes(v) || ((v === "usuarios" || v === "parametros") && YO.rol !== "admin")) v = "calculadora";   // incluye enlaces viejos (#/nueva, #/historial, #/resumen)
  $$(".vista").forEach(s => s.hidden = s.dataset.vista !== v);
  $$(".side-nav a").forEach(a => a.classList.toggle("on", a.dataset.v === v));
  if (v === "usuarios") cargarUsuarios();
  if (v === "inventario") cargarInventario();
  if (v === "calculadora") cargarCalculadora(arg);
  if (v === "tablero") cargarTablero();
  if (v === "pruebas") cargarPruebas();
  if (v === "parametros") cargarParametros();
  window.scrollTo(0, 0);
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


// ------------------------------------------------------------------ gráficos
Chart.defaults.font.family = "Inter, system-ui, sans-serif";
Chart.defaults.color = C.tx2;

function grafico(id, cfg) {
  if (charts[id]) { charts[id].data = cfg.data; charts[id].options = cfg.options; charts[id].update(); return charts[id]; }
  return (charts[id] = new Chart($("#" + id), cfg));
}


// ================================================================== USUARIOS (helper compartido)
const pill = e => `<span class="pill e-${e.replace(/ /g, "-")}">${esc(e)}</span>`;


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
      if (!activar && !confirm(`¿Desactivar a ${u}? Ya no podrá ingresar (sus registros se conservan).`)) return;
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
    cargarUsuarios();
  } catch (err) { error($("#usr-err"), err.message); }
});

// ================================================================== INVENTARIO Y PRECIO DINÁMICO
const usdE = v => v == null || isNaN(v) ? "–" : (v < 0 ? "-$" : "$") + Math.abs(Math.round(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");   // 18.950
const diaF = iso => new Date(String(iso).slice(0, 10) + "T12:00").toLocaleDateString("es-EC", { day: "2-digit", month: "short", year: "numeric" });
const SEM = { verde: "Normal", amarillo: "Atención", naranja: "Alerta", rojo: "Crítico" };
const COL_SEM = { verde: "#10B981", amarillo: "#F59E0B", naranja: "#F97316", rojo: "#EF4444" };
const casoPill = (c, n) => c ? `<span class="pill k-${c}">${esc(n)}</span>` : "";
const pct1 = v => v == null ? "–" : (v * 100).toFixed(1).replace(".", ",") + " %";
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

const ORDEN_SEM = { rojo: 0, naranja: 1, amarillo: 2, verde: 3 };
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
      <td class="num">${usdE(u.mercado)}<small${u.referencia.tipo === "modelo" ? ' class="down"' : ""} title="${esc(u.referencia_manual ? u.fuente_mercado_manual : u.referencia.fuente)}">${u.referencia_manual ? `<span class="tag-ref">Manual</span>` : esc(u.referencia.fuente)}</small></td>
      <td>${confPill(u.confianza)}</td><td class="num ${u.pct_vs_mercado > .03 ? "down" : u.pct_vs_mercado < -.03 ? "up" : ""}">${pctE(u.pct_vs_mercado)}</td>
      <td class="num"><b>${usdE(u.sugerido)}</b></td>
      <td>${recPill(u.recomendacion)} ${u.caso !== "con_ganancia" ? casoPill(u.caso, u.caso_nombre) : ""}<small class="rec-txt">${esc(u.texto)}</small></td><td class="num nw">${eq}</td></tr>`;
  }).join("");
}

$("#i-tabla thead").addEventListener("click", e => {
  const th = e.target.closest("th[data-k]"); if (!th) return;
  inv.orden = { k: th.dataset.k, dir: inv.orden.k === th.dataset.k ? -inv.orden.dir : 1 };
  pintarInventario();
});
$("#i-tabla tbody").addEventListener("click", e => { const tr = e.target.closest("tr[data-id]"); if (tr) location.hash = "#/calculadora/" + tr.dataset.id; });

// ------------------------------------------------------------------ nueva unidad (manual o desde un anuncio de 1001carros.com)
let nu = null;      // { marca, familia, version }
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

function abrirNuevaUnidad() {
  const f = $("#f-unidad"); f.reset();
  nu = { marca: null, familia: null, version: null };
  $("#cb-u-marca input").value = ""; $("#cb-u-modelo input").value = ""; $("#cb-u-modelo input").disabled = true;
  $("#u-version").disabled = true; $("#u-version").innerHTML = `<option value="">No sé / estándar</option>`;
  f.elements.fecha_ingreso.value = hoyISO();
  $("#u-anuncio").value = "";
  error($("#nu-err"), "");
  $("#m-unidad").hidden = false;
}
// "Partir de un carro publicado en 1001carros.com": 100 anuncios reales del 7-oct-2026
let ANUNCIOS = null;
async function cargarAnuncios() {
  if (ANUNCIOS) return;
  try { ANUNCIOS = await api("/api/anuncios1001"); } catch (e) { ANUNCIOS = []; return; }
  $("#u-anuncio").innerHTML = `<option value="">Elegir uno de los ${ANUNCIOS.length} anuncios del 7-oct-2026…</option>` +
    ANUNCIOS.map(a => `<option value="${a.idx}">${esc(a.marca)} ${esc(a.modelo)} ${a.anio} · ${Math.round(a.km).toLocaleString("es-EC")} km · ${usdE(a.precio)} · ${esc(a.ciudad)}</option>`).join("");
}
$("#u-anuncio").addEventListener("change", e => {
  const a = (ANUNCIOS || []).find(x => String(x.idx) === e.target.value); if (!a) return;
  const f = $("#f-unidad").elements;
  uMarca(a.marca); uModelo(a.familia);
  f.anio.value = a.anio; f.km.value = Math.round(a.km); f.costo_compra.value = a.costo; f.precio_publicado.value = a.precio;
  f.agencia.value = f.agencia.value || ""; $("#u-anuncio-hint").textContent = `${a.modelo} · publicado en 1001carros.com a ${usdE(a.precio)} (${a.ciudad}). Costo propuesto ${usdE(a.costo)} = precio ÷ 1,12; ajústalo si conoces el real.`;
});
$("#btn-nueva-unidad").addEventListener("click", () => { abrirNuevaUnidad(); cargarAnuncios(); });

$("#f-unidad").addEventListener("submit", async e => {
  e.preventDefault();
  if (!nu.familia) return error($("#nu-err"), "Elige la marca y el modelo de la lista");
  const d = Object.fromEntries([...new FormData(e.target)].filter(([, v]) => v !== ""));
  const body = { ...d, marca: nu.marca, familia: nu.familia, version: nu.version };
  try {
    const r = await api("/api/inventario", body);
    $("#m-unidad").hidden = true;
    toast(`${esc(nombreVeh(r.unidad))} agregada al inventario`);
    location.hash = "#/calculadora/" + r.unidad.id;
  } catch (err) { error($("#nu-err"), err.message); }
});

// ================================================================== CALCULADORA (primera pestaña)
// Un carro + sus días parados -> rango de precio de hoy con todo el razonamiento (motor de inventario.py, POST /api/calculadora).
// Si se abre desde una unidad del inventario (#/calculadora/ID) se muestran las acciones sobre la unidad.
let det = null;        // el cálculo que se está mostrando
let detU = null;       // la unidad tal como está guardada (las acciones usan siempre este)
const cal = { listo: false, unidadId: null, anuncio: null, refAuto: null, refEditada: false, stockEditado: false, sucio: false, pedido: 0 };
const cm = { marca: null, familia: null, version: null };
const REGION_DE = c => ["Guayaquil", "Manta", "Machala", "Cuenca", "Loja", "Portoviejo"].includes(c) ? "Costa/Austro" : "Sierra";
const CAL_DEFECTO = { marca: "Toyota", familia: "toyota corolla", version: null, anio: 2023, km: 52990, costo: 19570, dias: 74, region: "Sierra" };
const LS_CALC = "p1001-v5-calculadora";
const fechaDeDias = d => { const f = new Date(); f.setDate(f.getDate() - d); return new Date(f.getTime() - f.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const diasDeFecha = s => Math.max(0, Math.round((new Date(hoyISO() + "T12:00") - new Date(s + "T12:00")) / 864e5));
const marcarSucio = () => { cal.sucio = true; $("#cu-nota").hidden = !cal.unidadId; };

function armarCalculadora() {
  const marcas = Object.keys(CAT.marcas).sort((a, b) => CAT.marcas[b].n - CAT.marcas[a].n);
  combo($("#cb-c-marca"), () => marcas.map(m => ({ id: m, txt: m, n: CAT.marcas[m].n })), it => cMarca(it.id));
  combo($("#cb-c-modelo"), () => cm.marca ? CAT.marcas[cm.marca].modelos.map(f => ({ id: f.id, txt: f.nombre, n: f.n })) : [], it => cModelo(it.id));
  $("#c-version").addEventListener("change", e => { cm.version = e.target.value || null; cal.anuncio = null; marcarSucio(); pedirReferencia(); });
  $("#c-anio").addEventListener("change", () => { cal.anuncio = null; marcarSucio(); pedirReferencia(); });
  $("#c-fecha").addEventListener("change", e => { if (e.target.value) $("#c-dias").value = diasDeFecha(e.target.value); marcarSucio(); });
  $("#c-dias").addEventListener("input", e => { const d = parseInt(e.target.value, 10); if (d >= 0) $("#c-fecha").value = fechaDeDias(d); marcarSucio(); });
  $("#c-stock").addEventListener("input", () => { cal.stockEditado = true; marcarSucio(); });
  $("#c-ref").addEventListener("input", () => { cal.refEditada = $("#c-ref").value !== ""; marcarSucio(); hintCalc(); });
  $("#c-ref").addEventListener("change", () => { if ($("#c-ref").value === "" && cal.refAuto) { cal.refEditada = false; $("#c-ref").value = cal.refAuto.p; hintCalc(); } });
  ["c-km", "c-costo", "c-region"].forEach(id => $("#" + id).addEventListener("input", marcarSucio));
  $("#f-calc").addEventListener("submit", e => { e.preventDefault(); calcular(true); });
  $("#c-limpiar").addEventListener("click", limpiarCalc);
  $("#c-partir").addEventListener("change", e => partirDe(e.target.value));
  $("#cal-graf").addEventListener("toggle", () => { if ($("#cal-graf").open && det && !det.vendida) pintarGraficoCalc(); });
}

function cMarca(m) {
  cm.marca = m; cm.familia = null; cm.version = null; cal.anuncio = null;
  $("#cb-c-marca input").value = m;
  const mi = $("#cb-c-modelo input"); mi.disabled = false; mi.value = ""; mi.placeholder = `Modelos de ${m}…`;
  $("#c-version").disabled = true; $("#c-version").innerHTML = `<option value="">No sé / estándar</option>`;
  marcarSucio();
}
function cModelo(id, version = null, pedir = true) {
  const f = CAT.marcas[cm.marca].modelos.find(x => x.id === id); if (!f) return;
  cm.familia = id; cm.version = version; cal.stockEditado = false;
  if (pedir) cal.anuncio = null;
  $("#cb-c-modelo input").value = f.nombre;
  const sv = $("#c-version");
  sv.innerHTML = `<option value="">No sé / estándar</option>` + f.versiones.map(v => `<option value="${esc(v.id)}">${esc(v.nombre)}</option>`).join("");
  sv.disabled = !f.versiones.length; sv.value = version || "";
  marcarSucio();
  if (pedir) pedirReferencia();
}

// referencia que propone la regla (Apéndice E o, si el modelo no está en la muestra, el modelo como respaldo)
async function pedirReferencia() {
  cal.refEditada = false;
  const anio = parseInt($("#c-anio").value, 10);
  if (!cm.familia || !(anio >= 1980)) return;
  const id = ++cal.pedido;
  try {
    const r = await api("/api/calculadora/referencia?" + new URLSearchParams({ marca: cm.marca, familia: cm.familia, version: cm.version || "", anio }));
    if (id !== cal.pedido) return;
    cal.refAuto = r;
    if (!cal.refEditada) $("#c-ref").value = r.p;
    if (!cal.stockEditado) $("#c-stock").value = r.stock_auto;
    hintCalc();
  } catch (e) { $("#c-hint").textContent = e.message; }
}
function hintCalc() {
  const r = cal.refAuto;
  const ref = cal.refEditada ? "Referencia manual: la escribiste tú (borra el campo para volver a la de la regla)."
    : !r ? "La referencia se llena sola con la regla del Apéndice E."
    : r.tipo === "apendice" ? `Referencia: ${r.fuente}.`
    : "Este modelo no está en la muestra del Apéndice E: se propone la estimación del modelo (respaldo).";
  $("#c-hint").textContent = `${ref} La fecha y los días se calculan uno desde el otro; el stock se llena contando el inventario.`;
}

// «Partir de…»: una unidad del inventario o uno de los 100 anuncios de 1001carros.com
async function cargarPartir() {
  try {
    const [us, an] = await Promise.all([api("/api/calculadora/unidades"), ANUNCIOS ? Promise.resolve(ANUNCIOS) : api("/api/anuncios1001")]);
    ANUNCIOS = an;
    const actual = $("#c-partir").value;
    $("#c-partir").innerHTML = `<option value="">Elegir una unidad del inventario o un anuncio de 1001carros.com…</option>`
      + `<optgroup label="Unidades del inventario (${us.length})">${us.map(u => `<option value="u:${u.id}">${esc(u.vehiculo)} · ${u.dias} d · ${esc(u.agencia || "sin agencia")}</option>`).join("")}</optgroup>`
      + `<optgroup label="Publicados en 1001carros.com (${an.length}) · 7-oct-2026">${an.map(a => `<option value="a:${a.idx}">${esc(a.marca)} ${esc(a.modelo)} ${a.anio} · ${Math.round(a.km).toLocaleString("es-EC")} km · ${usdE(a.precio)} · ${esc(a.ciudad)}</option>`).join("")}</optgroup>`;
    $("#c-partir").value = actual;
  } catch (e) { /* el selector queda vacío; el formulario sigue funcionando */ }
}
async function partirDe(v) {
  if (!v) return;
  const [t, id] = v.split(":");
  if (t === "u") { location.hash = "#/calculadora/" + id; return; }
  const a = (ANUNCIOS || []).find(x => String(x.idx) === id); if (!a) return;
  cal.unidadId = null; detU = null;
  history.replaceState(null, "", "#/calculadora");
  cMarca(a.marca); cModelo(a.familia, null, false);
  cal.anuncio = a;
  $("#c-anio").value = a.anio; $("#c-km").value = Math.round(a.km); $("#c-costo").value = a.costo; $("#c-region").value = REGION_DE(a.ciudad);
  if (!(parseInt($("#c-dias").value, 10) >= 0)) { $("#c-dias").value = 30; $("#c-fecha").value = fechaDeDias(30); }
  $("#c-partir-hint").textContent = `${a.modelo} · publicado en 1001carros.com a ${usdE(a.precio)} (${a.ciudad}). Costo estimado = precio ÷ 1,12 = ${usdE(a.costo)}. Cambia los días para ver cómo se mueve el precio.`;
  await pedirReferencia();
  cal.sucio = false;
  calcular(false);
}

function llenarDesdeUnidad(r) {
  const u = r.unidad, e = r.evaluacion;
  cMarca(u.marca); cModelo(u.familia, u.version, false);
  $("#c-anio").value = u.anio; $("#c-km").value = u.km ?? ""; $("#c-costo").value = (u.costo_compra || 0) + (u.reacondicionamiento || 0);
  $("#c-dias").value = e.dias; $("#c-fecha").value = fechaDeDias(e.dias); $("#c-region").value = u.region || "Sierra";
  $("#c-partir-hint").textContent = `Unidad del inventario: ${nombreVeh(u)}${u.agencia ? " · " + u.agencia : ""}. Cambia los datos para simular otro escenario; las acciones de abajo usan lo guardado.`;
  if (!r.vendida) {
    $("#c-stock").value = r.calc.stock; cal.stockEditado = false; cal.refAuto = r.calc.referencia_auto;
    cal.refEditada = u.mercado_manual != null;
    $("#c-ref").value = cal.refEditada ? u.mercado_manual : cal.refAuto.p;
    hintCalc();
  }
  cal.sucio = false; $("#cu-nota").hidden = true;
}

async function cargarCalculadora(id) {
  cargarPartir();
  if (id) {
    try { detU = await api("/api/calculadora", { unidad_id: +id }); }
    catch (e) { toast("⚠️ " + esc(e.message)); location.hash = "#/inventario"; return; }
    cal.unidadId = +id; cal.anuncio = null; cal.listo = true;
    $("#c-partir").value = "u:" + id; error($("#c-err"), "");
    llenarDesdeUnidad(detU); det = detU; pintarCalc();
    return;
  }
  if (cal.listo) return;                       // el menú no borra lo que había en pantalla
  cal.listo = true;
  let g = CAL_DEFECTO;
  try { g = { ...CAL_DEFECTO, ...(JSON.parse(localStorage.getItem(LS_CALC) || "null") || {}) }; } catch (_) {}
  if (!CAT.marcas[g.marca] || !CAT.marcas[g.marca].modelos.some(f => f.id === g.familia)) g = CAL_DEFECTO;
  cMarca(g.marca); cModelo(g.familia, g.version, false);
  $("#c-anio").value = g.anio; $("#c-km").value = g.km ?? ""; $("#c-costo").value = g.costo; $("#c-dias").value = g.dias; $("#c-fecha").value = fechaDeDias(+g.dias || 0);
  $("#c-region").value = g.region || "Sierra";
  await pedirReferencia();
  if (g.ref) { $("#c-ref").value = g.ref; cal.refEditada = true; hintCalc(); }
  cal.sucio = false;
  calcular(false);
}

function limpiarCalc() {
  cal.unidadId = null; cal.anuncio = null; cal.refAuto = null; cal.refEditada = false; cal.stockEditado = false; detU = null; det = null; cm.marca = cm.familia = cm.version = null;
  history.replaceState(null, "", "#/calculadora");
  $("#f-calc").reset();
  $("#cb-c-marca input").value = ""; $("#cb-c-modelo input").value = ""; $("#cb-c-modelo input").disabled = true; $("#cb-c-modelo input").placeholder = "Elige primero la marca";
  $("#c-version").disabled = true; $("#c-version").innerHTML = `<option value="">No sé / estándar</option>`;
  $("#c-dias").value = 0; $("#c-fecha").value = hoyISO(); $("#c-partir").value = ""; error($("#c-err"), "");
  $("#c-partir-hint").textContent = "Al elegir uno se llenan los datos. De un anuncio de 1001carros.com, el costo se estima como precio publicado ÷ 1,12 (margen de ingreso de la empresa) y el precio publicado queda para compararlo.";
  hintCalc();
  $("#cal-unidad").hidden = true; $("#un-vendida").hidden = true; $("#cal-lleno").hidden = true; $("#cal-vacio").hidden = false;
  $("#cal-vacio").innerHTML = "Completa los datos y pulsa <b>Calcular precio</b>.";
  ["un-costo", "un-mercado", "un-comps-card", "un-hist-card", "un-refs-card"].forEach(id => $("#" + id).hidden = true);
  try { localStorage.removeItem(LS_CALC); } catch (_) {}
}

async function calcular(desplazar) {
  error($("#c-err"), "");
  const costo = +$("#c-costo").value, dias = parseInt($("#c-dias").value, 10);
  if (detU && detU.vendida) return error($("#c-err"), "Esta unidad ya está vendida: no hay precio que calcular");
  if (!cm.familia) return error($("#c-err"), "Elige la marca y el modelo de la lista");
  if (!(+$("#c-anio").value >= 1980)) return error($("#c-err"), "Escribe el año del carro");
  if (!(costo > 0)) return error($("#c-err"), "Escribe un costo de recepción mayor que cero");
  if (!(dias >= 0)) return error($("#c-err"), "Escribe los días en inventario (0 o más)");
  const body = { marca: cm.marca, familia: cm.familia, version: cm.version || "", anio: +$("#c-anio").value, km: $("#c-km").value, costo_compra: costo,
    dias, stock: $("#c-stock").value, region: $("#c-region").value };
  if (cal.unidadId) body.unidad_id = cal.unidadId;
  if (cal.refEditada) body.mercado_manual = $("#c-ref").value;
  if (cal.anuncio) { body.precio_anuncio = cal.anuncio.precio; body.precio_publicado = cal.anuncio.precio; }
  const b = $("#c-calcular"); b.disabled = true;
  try {
    det = await api("/api/calculadora", body);
    pintarCalc();
    if (!cal.unidadId) try { localStorage.setItem(LS_CALC, JSON.stringify({ marca: cm.marca, familia: cm.familia, version: cm.version, anio: body.anio, km: body.km, costo, dias, region: body.region, ref: cal.refEditada ? $("#c-ref").value : null })); } catch (_) {}
    if (desplazar && angosta()) $("#cal-res").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { error($("#c-err"), e.message); }
  finally { b.disabled = false; }
}

const TRAMO_COLOR = { verde: "t-verde", amarillo: "t-amarillo", naranja: "t-naranja", rojo: "t-rojo" };
const mesDia = iso => new Date(iso + "T12:00").toLocaleDateString("es-EC", { day: "numeric", month: "short" });

function pintarCalc() {
  const sold = !!det.vendida, { unidad: u, evaluacion: e } = det, unidad = !!cal.unidadId;
  $("#cal-vacio").hidden = !sold; $("#cal-lleno").hidden = sold;
  $("#un-vendida").hidden = !(unidad && sold); $("#cal-unidad").hidden = !(unidad && !sold);
  $("#un-hist-card").hidden = !unidad; $("#un-ref-btn").hidden = !unidad || sold;
  $("#un-historial").innerHTML = det.historial.map(h => `<tr><td class="nw">${fechaCorta(h.fecha)}</td>
    <td class="num">${usdE(h.precio_anterior)}</td><td class="num"><b>${usdE(h.precio_nuevo)}</b></td><td class="num">${usdE(h.precio_sugerido)}</td>
    <td>${esc(h.motivo || "–")}</td><td>${esc(h.nombre_usuario || h.usuario || "–")}</td></tr>`).join("");
  pintarCostoMercado(sold);
  $("#un-costo").hidden = false; $("#un-comps-card").hidden = sold;
  if (sold) {
    $("#cal-vacio").innerHTML = `Esta unidad ya fue <b>${esc(u.estado.toLowerCase())}</b>: no hay precio que calcular.`;
    const dif = u.precio_venta - u.precio_publicado;
    $("#un-vendida").innerHTML = `<h3 class="card-tit">${esc(nombreVeh(u))} · ${esc(u.estado)} el ${diaF(u.fecha_venta)}</h3><div class="vend-grid">
      <div><small>Precio de venta</small><b>${usdE(u.precio_venta)}</b></div><div><small>Días en piso</small><b>${e.dias}</b></div>
      <div><small>Costo acumulado a la venta</small><b>${usdE(e.costo_acumulado)}</b></div>
      <div><small>Utilidad real</small><b class="${e.utilidad >= 0 ? "up" : "down"}">${usdE(e.utilidad)}</b></div></div>
      <p class="hint">Último precio publicado: ${usdE(u.precio_publicado)} (${dif >= 0 ? "vendió " + usdE(dif) + " sobre" : "descuento de " + usdE(-dif) + " frente a"} lo publicado).</p>
      <div class="row-btns"><button class="btn btn-ghost" type="button" id="uv-estado">Cambiar estado</button><button class="btn btn-ghost" type="button" id="uv-editar">✎ Editar datos</button></div>`;
    return;
  }
  const c = det.calc, p = det.parametros, esc_ = c.escalera.find(x => x.actual);
  // 1. precio sugerido hoy
  $("#cal-precio").textContent = usdE(e.sugerido);
  // v7 (pruebas con usuarios): una sola línea con los dos números que el asesor necesita
  $("#cal-decision").innerHTML = e.minimo === e.maximo
    ? `Publica y acepta <b>${usdE(e.maximo)}</b> (sin margen para negociar)`
    : `Publica en <b>${usdE(e.maximo)}</b> y acepta hasta <b>${usdE(e.minimo)}</b>`;
  $("#cal-margen").textContent = `Margen proyectado ${pct1(c.margen_pct)} (${usdE(c.margen_usd)} sobre el costo acumulado).`;
  const pill = $("#cal-pill"); pill.className = "pill " + TRAMO_COLOR[esc_.color]; pill.textContent = `${esc_.estado} · día ${e.dias}`;
  // 2. rango: mínimo · objetivo · máximo
  const unico = e.minimo === e.maximo;
  const notas = { minimo: e.caso === "ganancia_reducida" ? "punto de equilibrio" : unico ? "igual al objetivo" : "piso de negociación", objetivo: "precio sugerido", maximo: "precio de publicación" };
  $("#cal-banda").innerHTML = e.banda.map(b => `<div class="${b.clave === "objetivo" ? "medio" : ""}"><small>${b.nombre}</small><b>${usdE(b.precio)}</b>
    <span class="${b.utilidad >= 0 ? "up" : "down"}">${b.utilidad >= 0 ? "deja " + usdE(b.utilidad) : "pierde " + usdE(-b.utilidad)} · ${pct1(b.pct)}</span><em>${notas[b.clave]}</em></div>`).join("");
  $("#cal-banda-nota").innerHTML = unico ? `<b>El rango se cierra:</b> el mínimo y el máximo son el mismo precio (${usdE(e.sugerido)}); no hay margen para negociar sin pasar por el comité.`
    : `El asesor puede aceptar hasta el <b>mínimo</b> sin pasar por el comité; el <b>máximo</b> es el precio de publicación. Fuera del rango es una excepción.`;
  // 3. datos del cálculo
  const rev = c.proxima_revision.fecha ? `${mesDia(c.proxima_revision.fecha)} (día ${c.proxima_revision.dia}: cambia de tramo)` : `cada semana en el comité (cada ${c.proxima_revision.cada_dias} días)`;
  const aj = e.ajuste_stock ? ` − ${pct1(e.ajuste_stock)} por stock (${e.stock} unidades)` : "";
  const fila = [
    ["Costo de recepción", usdE(e.costo_base)],
    ["Margen objetivo del tramo", pct1(e.margen_tramo) + aj],
    ["Referencia de mercado", `${usdE(e.mercado)} × ${(1 + e.tope_tramo).toFixed(2).replace(".", ",")} = ${usdE(e.tope_mercado)} (tope)<small>${esc(e.referencia.fuente)}</small>`],
    ["Costo acumulado", `${usdE(e.costo_acumulado)} (${usd2E(e.costo_diario)} por día)`],
    ["Cada semana más de espera cuesta", usdE(c.costo_semanal)],
    ["Piso de ganancia", `${usdE(e.piso_ganancia)} (costo acumulado + ${pct1(p.margen_minimo)})`],
    ["Próxima revisión", rev],
  ];
  $("#cal-kv").innerHTML = fila.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join("");
  // 4. acción del tramo · 5. histórico del modelo
  $("#cal-accion").innerHTML = `<b>Acción:</b> ${esc(e.accion_comercial)}`;
  $("#cal-hist").textContent = c.historico.texto;
  // 6. escalera de precio según los días
  $("#cal-escalera").innerHTML = c.escalera.map(x => `<div class="esc ${TRAMO_COLOR[x.color]}${x.actual ? " now" : ""}"><b>${usdE(x.precio)}</b><span>${esc(x.nombre)} días</span><em>${pct1(x.margen_pct)} · ${usdE(x.margen_usd)}</em></div>`).join("");
  // 7. los dos caminos
  const cm_ = e.caminos, largo = cm_.modo === "espera_larga", gana = cm_.diferencia >= 0;
  const caja = (cls, tit, v, txt) => `<div class="${cls}"><small>${tit}</small><b class="${v >= 0 ? "" : "down"}">${usdE(v)}</b><span>${txt}</span></div>`;
  $("#cal-caminos").innerHTML =
    caja(gana ? "bueno" : "", "Camino 1 · vender en este tramo", cm_.vender_hoy, `Al precio sugerido (${usdE(e.sugerido)}) menos el costo acumulado (${usdE(e.costo_acumulado)}).`)
    + caja(gana ? "" : "bueno", largo ? `Camino 2 · dejarlo pasar a ${cm_.hasta_dia} días` : "Camino 2 · esperar 30 días más", cm_.esperar,
        largo ? `Margen de ${pct1(cm_.margen_espera)} (${usdE(cm_.margen_usd)}) a los ${cm_.hasta_dia} días, menos ${usdE(cm_.costo_espera)} de costo de capital por ${cm_.dias_extra} días más.`
              : `Precio de la regla en el día ${cm_.hasta_dia} menos el costo acumulado de ese día (${usdE(cm_.costo_espera)} más de costo).`)
    + `<div class="ancho ${gana ? "bueno" : ""}"><small>${gana ? "Diferencia a favor de vender ahora" : "Diferencia a favor de esperar"}</small><b>${usdE(Math.abs(cm_.diferencia))}</b>
       <span>${gana ? "Es la cifra que suma el business case por cada unidad que deja de envejecer." : "Con estos números esperar deja más; revisar el costo o la referencia de mercado."}</span>
       <span class="ref-bc"><b>Business case:</b> ${usdE(c.business_case.beneficio_unidad)} por unidad rescatada (${usdE(c.business_case.margen_unidad)} de margen recuperado + ${usdE(c.business_case.capital_unidad)} de capital evitado), en promedio. La diferencia de esta unidad es <b>${usdE(Math.abs(cm_.diferencia))}</b>.</span></div>`;
  $("#cal-caminos-fuente").textContent = largo
    ? `${p.dias_espera} días es el promedio de las unidades que pasan de 120 días y ${pct1(p.margen_espera)} el margen con que se venden (business case).`
    : `La unidad ya pasó el día ${p.dias_espera}: se compara con esperar 30 días más.`;
  // 8. por qué este precio · 9. comparación con el anuncio
  $("#cal-pasos").innerHTML = c.pasos.map(t => `<li>${esc(t)}</li>`).join("");
  $("#cal-comp").hidden = !c.comparacion; $("#cal-comp").textContent = c.comparacion || "";
  // 10. segunda opinión del modelo y gráfico plegable
  const so = e.referencia.segunda_opinion;
  $("#cal-seg").innerHTML = so
    ? `<div class="${so.aviso ? "mal" : ""}"><b>${usdE(so.valor)}</b><span>${esc(so.texto)}${so.aviso ? "" : ". La referencia y el modelo van en la misma línea."}</span></div>`
    : `<div><b>${usdE(e.mercado)}</b><span>${esc(e.referencia.etiqueta || "El valor sale del modelo")}: no hay otra referencia con la que compararlo.</span></div>`;
  if ($("#cal-graf").open) pintarGraficoCalc();
  // acciones sobre la unidad
  if (unidad) pintarUnidadCard();
}

function pintarUnidadCard() {
  const su = detU.unidad, e = det.evaluacion, dif = su.precio_publicado - e.sugerido;
  $("#cu-badge").textContent = `${nombreVeh(su)} · ${su.agencia || "sin agencia"}`;
  const kv = [
    ["Precio publicado hoy", usdE(su.precio_publicado)],
    ["Precio objetivo", usdE(e.sugerido)],
    ["Diferencia", `${dif >= 0 ? "+" : "−"}${usdE(Math.abs(dif))} (${pct1(Math.abs(dif) / e.sugerido)}) ${recPill(e.recomendacion)}`],
    ["Estado de la unidad", `${estPill(su.estado)} ${semDot(detU.evaluacion.semaforo)} ${SEM[detU.evaluacion.semaforo] || ""}`],
    ["Última revisión", su.ultima_revision ? diaF(su.ultima_revision) : "sin registro"],
  ];
  $("#cu-kv").innerHTML = kv.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join("");
  const h = detU.historial.slice(0, 4);
  $("#cu-hist").innerHTML = "<b>Historial de la unidad</b><br>" + (h.length ? h.map(x => `${fechaCorta(x.fecha)} · ${x.precio_anterior != null ? usdE(x.precio_anterior) + " → " : ""}${usdE(x.precio_nuevo)}${x.motivo ? " · " + esc(x.motivo) : ""}`).join("<br>") : "Sin acciones registradas.");
  $("#cu-nota").hidden = !cal.sucio;
}

// costo diario (desglose), confianza del mercado, referencia manual y comparables
function pintarCostoMercado(v) {
  const { unidad: u, evaluacion: e, desglose: g } = det;
  $("#un-costo-sub").textContent = g.total_manual
    ? "Esta unidad tiene un costo diario propio que reemplaza el cálculo por parámetros."
    : "El costo de esperar es el capital: 12 % × (compra + reacondicionamiento) ÷ 365, como en el business case. Seguro, patio y lavado solo aparecen si se activan en Parámetros.";
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
    : e.referencia.tipo === "apendice"
    ? `<div class="fuerte"><small>Mercado: Apéndice E de la Entrega 1</small><b>${usdE(e.referencia.p)}</b><span>${esc(e.referencia.fuente)} · mediana de Patiotuerca y Autocor, 7-oct-2026${e.referencia.exacta ? "" : `; el valor de hoy (día ${e.dias}) con 6 % anual es ${usdE(e.mercado)}`}</span></div>
       <div class="${e.referencia.segunda_opinion.aviso ? "mal" : ""}"><small>Segunda opinión: modelo XGBoost</small><b>${usdE(e.referencia.segunda_opinion.valor)}</b><span>${esc(e.referencia.segunda_opinion.texto)}</span></div>`
    : `<div class="fuerte"><small>Mercado: ${esc(e.referencia.etiqueta)}</small><b>${usdE(e.mercado)}</b><span>${esc(e.referencia.fuente)} · rango ${usdE(e.bajo50)} – ${usdE(e.alto50)}</span></div>
       <div><small>Precio de nuevo</small><b>${u.pn_con_iva ? usdE(u.pn_con_iva) : "Sin dato"}</b><span>${u.pn_con_iva ? (u.pn_origen === "manual" ? "ingresado a mano" : u.pn_origen === "cotización" ? "cargado con la unidad" : "detectado en el catálogo") : "el modelo trabaja sin este dato"}</span></div>`;
  const hm = det.historico_modelo;
  $("#un-hist-modelo").hidden = !hm; if (hm) $("#un-hist-modelo").innerHTML = `<b>Histórico del modelo</b>: ${esc(hm.texto)}`;
  $("#un-ref-btn").textContent = man ? "Cambiar o retirar la referencia…" : "Fijar referencia manual…";
  $("#un-comps-sub").textContent = det.comparables.length
    ? `Los ${det.comparables.length} avisos más parecidos de ${det.n_comparables} de la familia (año ±4, km similar). El valor de mercado de hoy es ${usdE(e.mercado)} (${esc(e.referencia.fuente)}).`
    : "";
  $("#un-comps-vacio").hidden = det.comparables.length > 0;
  $("#un-comps").innerHTML = det.comparables.map(a => `<tr><td>${esc(a.titulo)}</td><td class="num">${a.anio}</td><td class="num">${a.km == null ? "–" : Math.round(a.km).toLocaleString("es-EC")}</td>
    <td class="num"><b>${usdE(a.precio)}</b></td><td class="num ${a.dif > .15 ? "down" : a.dif < -.15 ? "up" : ""}">${pctE(a.dif)}</td><td>${esc(a.ciudad || "–")}</td>
    <td>${a.url ? `<a class="enlace" href="${esc(a.url)}" target="_blank" rel="noopener">Ver aviso ↗</a>` : ""}</td></tr>`).join("");
}

// ------------------------------------------------------------------ gráfico del detalle: "¿A qué precio vender según los días?"
// 4 colores en toda la app: precio sugerido = principal, mercado = gris azulado, zona sin ganancia = rojo suave, publicado = ámbar.
const CG = { sug: "#3730A3", mer: "#64748B", rojo: "#DC2626", pub: "#D97706", tx: "#6B7280" };
const angosta = () => window.matchMedia("(max-width: 640px)").matches;

// franjas de tramo muy tenues con su nombre, línea vertical "Hoy · día X" y etiquetas directas al final de cada línea
const fondoTramos = {
  id: "fondoTramos",
  beforeDatasetsDraw(ch) {
    const o = ch.options.plugins.fondoTramos; if (!o) return;
    const { ctx, chartArea: a, scales: { x } } = ch;
    const lim = [0, ...o.limites], tint = ["rgba(100,116,139,.035)", "rgba(100,116,139,.075)"];
    ctx.save(); ctx.textAlign = "center"; ctx.font = "600 11px Inter, sans-serif";
    lim.forEach((ini, i) => {
      const x0 = Math.max(x.getPixelForValue(ini), a.left), x1 = i < o.limites.length ? Math.min(x.getPixelForValue(lim[i + 1]), a.right) : a.right;
      if (x1 <= x0) return;
      ctx.fillStyle = tint[i % 2]; ctx.fillRect(x0, a.top, x1 - x0, a.bottom - a.top);
      const txt = o.nombres[i] + (angosta() ? "" : " d");                 // el nombre solo si cabe en la franja
      if (ctx.measureText(txt).width + 6 < x1 - x0) { ctx.fillStyle = CG.tx; ctx.fillText(txt, (x0 + x1) / 2, a.top + 13); }
    });
    ctx.restore();
  },
  afterDatasetsDraw(ch) {
    const o = ch.options.plugins.fondoTramos; if (!o) return;
    const { ctx, chartArea: a, scales: { x } } = ch;
    if (o.hoy != null) {
      const px = x.getPixelForValue(o.hoy);
      ctx.save(); ctx.strokeStyle = "#240078"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(px, a.top + 20); ctx.lineTo(px, a.bottom); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#240078"; ctx.font = "700 11px Inter, sans-serif"; ctx.textAlign = px > a.right - 80 ? "right" : "left";
      ctx.fillText("Hoy · día " + o.hoy, px + (px > a.right - 80 ? -5 : 5), a.top + 32); ctx.restore();
    }
    // etiquetas directas al final de cada línea visible (sin choques: se separan 13 px)
    const et = [];
    ch.data.datasets.forEach((ds, i) => { if (ds.etq && ch.isDatasetVisible(i) && ds.data.length) { const pt = ch.getDatasetMeta(i).data[ds.data.length - 1]; et.push({ y: pt.y, txt: ds.etq, col: ds.etqColor || ds.borderColor }); } });
    et.sort((p, q) => p.y - q.y); for (let k = 1; k < et.length; k++) if (et[k].y - et[k - 1].y < 13) et[k].y = et[k - 1].y + 13;
    ctx.save(); ctx.font = "700 11px Inter, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    et.forEach(l => { ctx.fillStyle = l.col; ctx.fillText(l.txt, a.right + 6, l.y); }); ctx.restore();
    // etiqueta del precio publicado (un solo punto, "hoy")
    const ip = ch.data.datasets.findIndex(d => d.pubPunto);
    if (ip >= 0 && ch.isDatasetVisible(ip)) { const pt = ch.getDatasetMeta(ip).data[0]; if (pt) {
      ctx.save(); ctx.font = "700 11px Inter, sans-serif"; ctx.fillStyle = CG.pub; ctx.textAlign = pt.x > a.right - 120 ? "right" : "left"; ctx.textBaseline = "bottom";
      ctx.fillText("Publicado " + usdE(ch.data.datasets[ip].data[0].y), pt.x + (pt.x > a.right - 120 ? -10 : 10), pt.y - 6); ctx.restore(); } }
  },
};

function fraseGrafico() {
  const { unidad: u, evaluacion: e } = det;
  let t = `Hoy (día ${e.dias}) conviene publicar en ${usdE(e.sugerido)}.`;
  if (e.caso === "perdida_inevitable") t += ` El costo acumulado (${usdE(e.costo_acumulado)}) ya supera al mercado (${usdE(e.mercado)}): desde el día ${e.dia_equilibrio} no hay ganancia posible y cada día la pérdida crece.`;
  else if (e.dia_equilibrio != null) t += ` Hasta el día ${e.dia_equilibrio} se puede vender con ganancia; después, el costo acumulado supera al mercado.`;
  else t += " En el período mostrado el mercado sigue cubriendo el costo acumulado.";
  return t;
}

function pintarGraficoCalc() {
  const { unidad: u, evaluacion: e, curvas: cv, parametros: p } = det;
  const pubReal = !!(cal.unidadId || cal.anuncio);        // sin unidad ni anuncio el publicado es solo un supuesto: no se dibuja
  const diaDe = f => Math.max(0, Math.round((new Date(String(f).slice(0, 10) + "T12:00") - new Date(u.fecha_ingreso + "T12:00")) / 864e5));
  const xmax = cv[cv.length - 1].d, vis = cv.filter(r => r.d <= xmax);
  const eq = e.dia_equilibrio != null && e.dia_equilibrio <= xmax ? cv[e.dia_equilibrio] : null;
  const pt = (k, f) => cv.map(r => ({ x: r.d, y: f ? f(r) : r[k] }));
  // eje Y ajustado a los datos con 5 % de margen (no empieza en cero)
  const vals = vis.flatMap(r => [r.mercado, r.bajo50, r.alto50, r.costo, r.piso, r.sugerido]).concat(pubReal ? [u.precio_publicado] : []);
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.05 || hi * 0.05;
  const rango = hi - lo + 2 * pad, paso = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000].find(s => rango / s <= 8) || 20000;   // cifras redondas en el eje
  const corto = angosta();
  const linea = (label, data, color, extra = {}) => ({ label, data, borderColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 0, fill: false, ...extra });
  grafico("ch-calc", {
    type: "line",
    plugins: [fondoTramos],
    data: { datasets: [
      { label: "Rango probable de mercado", data: pt("alto50"), borderWidth: 0, pointRadius: 0, fill: "+1", backgroundColor: "rgba(100,116,139,.13)" },
      { label: "bajo50", data: pt("bajo50"), borderWidth: 0, pointRadius: 0, fill: false },
      linea("Valor de mercado", pt("mercado"), CG.mer, { borderWidth: 1.6, tension: .25, etq: corto ? "Mercado" : "Valor de mercado" }),
      { label: "Zona sin ganancia", data: pt("piso"), borderWidth: 0, pointRadius: 0, fill: "origin", backgroundColor: "rgba(220,38,38,.10)" },
      linea("Punto de equilibrio (costo acumulado)", pt("costo"), CG.rojo, { borderDash: [2, 3], borderWidth: 1.8, etq: corto ? "Equilibrio" : "Equilibrio (costo)" }),
      linea("Precio sugerido", pt("sugerido"), CG.sug, { stepped: true, borderWidth: 3.6, etq: corto ? "Sugerido" : "Precio sugerido" }),
      { label: "Precio publicado hoy", type: "scatter", data: pubReal ? [{ x: e.dias, y: u.precio_publicado }] : [], pointStyle: "circle", pointRadius: 8, pointHoverRadius: 9, backgroundColor: CG.pub, borderColor: "#fff", borderWidth: 2, pubPunto: true },
      { label: "Desde aquí ya no hay ganancia", type: "scatter", data: eq ? [{ x: eq.d, y: eq.costo }] : [], pointStyle: "rectRot", pointRadius: 9, pointHoverRadius: 10, backgroundColor: CG.rojo, borderColor: "#fff", borderWidth: 2 },
      // series secundarias: arrancan ocultas, se activan desde la leyenda
      linea("Objetivo por margen", pt("objetivo"), CG.sug, { hidden: true, borderDash: [8, 5], borderWidth: 1.4, tension: .2 }),
      linea("Tope de mercado del tramo", pt("tope"), CG.mer, { hidden: true, borderDash: [8, 5], borderWidth: 1.4, tension: .2 }),
      ...(e.referencia.tipo !== "modelo" ? [linea(e.referencia_manual ? "Valor del modelo (sin referencia)" : "Modelo XGBoost (segunda opinión)", pt("modelo"), CG.mer, { hidden: true, borderDash: [3, 3], borderWidth: 1.2, tension: .25 })] : []),
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
      layout: { padding: { right: corto ? 58 : 118, top: 4 } },
      interaction: { mode: "index", intersect: false, axis: "x" },
      plugins: {
        fondoTramos: { limites: p.tramos, nombres: det.tramos, hoy: e.dias },
        legend: { position: "bottom", labels: { usePointStyle: true, boxWidth: 8, font: { size: corto ? 11 : 12 },
          filter: it => !["bajo50", "Rango probable de mercado"].includes(it.text) } },
        tooltip: { backgroundColor: "#240078", padding: 10, displayColors: false, filter: it => it.dataset.label === "Precio sugerido",
          callbacks: {
            title: it => `Día ${it[0].parsed.x} · ${diaF(new Date(new Date(u.fecha_ingreso + "T12:00").getTime() + it[0].parsed.x * 864e5).toISOString())}`,
            label: it => { const r = cv[it.parsed.x], util = r.sugerido - r.costo;
              return [`Precio sugerido: ${usdE(r.sugerido)}`, `Valor de mercado: ${usdE(r.mercado)}`, `Piso de ganancia: ${usdE(r.piso)}`,
                      `Utilidad si se vende ese día: ${util >= 0 ? "" : "−"}${usdE(Math.abs(util))}`]; } } },
      },
      scales: { x: { type: "linear", min: 0, max: xmax, title: { display: !corto, text: "Días en inventario" }, grid: { display: false }, ticks: { stepSize: [15, 30, 60, 90].find(s => xmax / s <= (corto ? 6 : 13)) || 120 } },
                y: { min: Math.floor((lo - pad) / paso) * paso, max: Math.ceil((hi + pad) / paso) * paso, grid: { color: C.line },
                     ticks: { stepSize: paso, callback: v => usdE(v), maxTicksLimit: corto ? 6 : 9 } } },
    },
  });
  $("#cal-grafico-frase").textContent = fraseGrafico();
}

const recargarUnidad = () => cargarCalculadora(cal.unidadId);
$("#un-aplicar").addEventListener("click", async () => {
  const b = $("#un-aplicar"); b.disabled = true;
  try {
    await api(`/api/inventario/${detU.unidad.id}/precio`, { aplicar_sugerido: true });
    await recargarUnidad(); toast(`Precio de revisión registrado: ${usdE(detU.unidad.precio_publicado)}`);
  } catch (err) { toast("⚠️ " + esc(err.message)); }
  finally { b.disabled = false; }
});
$("#un-confirmar").addEventListener("click", async () => {          // confirmar revisión: mantener el precio publicado (con motivo si no está dentro de la banda)
  const e = detU.evaluacion;
  if (e.recomendacion !== "Mantener") {
    mantener = String(detU.unidad.id); mantenerDesdeCalc = true; $("#f-mantener").reset(); error($("#mt-err"), "");
    $("#mt-sub").innerHTML = `<b>${esc(nombreVeh(detU.unidad))}</b>: se mantiene en ${usdE(detU.unidad.precio_publicado)} aunque el sugerido es ${usdE(e.sugerido)}. Queda como excepción para que el administrador la apruebe.`;
    $("#m-mantener").hidden = false; return;
  }
  try {
    await api(`/api/inventario/${detU.unidad.id}/precio`, { mantener: true, motivo: "Revisión confirmada: el precio publicado está dentro de la banda" });
    await recargarUnidad(); toast("Revisión confirmada");
  } catch (err) { toast("⚠️ " + esc(err.message)); }
});

function avisoPrecio() {
  const e = detU.evaluacion, f = $("#f-precio"), nuevo = +f.elements.precio.value;
  const lejos = nuevo > 0 && (nuevo < e.minimo - .5 || nuevo > e.maximo + .5), util = nuevo - e.costo_acumulado;
  $("#pr-aviso").innerHTML = nuevo > 0 ? `${util >= 0 ? "Deja " + usdE(util) : "<span class='down'>Pierde " + usdE(-util) + "</span>"} sobre el costo acumulado; ${pctE(nuevo / e.sugerido - 1, 1)} frente al objetivo.`
    + (lejos ? ` <b>${nuevo < e.minimo ? "Bajo el mínimo" : "Sobre el máximo"} de la banda: es una excepción para el comité, escribe el motivo.</b>` : "") : "";
  f.elements.motivo.required = lejos;
}
$("#un-otro").addEventListener("click", () => {
  const e = detU.evaluacion, f = $("#f-precio"); f.reset();
  $("#pr-sug").innerHTML = `Sugerido: <b>${usdE(e.sugerido)}</b> · publicado hoy: ${usdE(detU.unidad.precio_publicado)}. Sin justificar se permite dentro de la banda <b>${usdE(e.minimo)} – ${usdE(e.maximo)}</b>.`;
  f.elements.precio.value = Math.round(e.sugerido); error($("#pr-err"), ""); avisoPrecio();
  $("#m-precio").hidden = false;
});
$("#f-precio").elements.precio.addEventListener("input", avisoPrecio);
$("#f-precio").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await api(`/api/inventario/${detU.unidad.id}/precio`, { precio: +e.target.elements.precio.value, motivo: e.target.elements.motivo.value });
    $("#m-precio").hidden = true; await recargarUnidad(); toast(`Precio actualizado a ${usdE(detU.unidad.precio_publicado)}`);
  } catch (err) { error($("#pr-err"), err.message); }
});

function camposVenta() { $("#vt-campos").hidden = !["Vendida", "Liquidada"].includes($("#f-venta").elements.estado_inv.value); }
$("#f-venta").elements.estado_inv.addEventListener("change", camposVenta);
function abrirVender() {
  const f = $("#f-venta"), u = detU.unidad; f.reset();
  f.elements.estado_inv.value = vendida(u) ? u.estado : "Vendida";
  f.elements.fecha_venta.value = u.fecha_venta || hoyISO();
  f.elements.precio_venta.value = Math.round(u.precio_venta || u.precio_publicado);
  error($("#vt-err"), ""); camposVenta(); $("#m-venta").hidden = false;
}
$("#un-vender").addEventListener("click", abrirVender);
$("#un-vendida").addEventListener("click", e => { if (e.target.closest("#uv-estado")) abrirVender(); else if (e.target.closest("#uv-editar")) abrirEditar(false); });
$("#f-venta").addEventListener("submit", async e => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target)); d.estado = d.estado_inv; delete d.estado_inv;
  if (!["Vendida", "Liquidada"].includes(d.estado)) { delete d.fecha_venta; delete d.precio_venta; }
  try {
    await api(`/api/inventario/${detU.unidad.id}`, d);
    $("#m-venta").hidden = true; await recargarUnidad(); toast("Estado actualizado: " + esc(detU.unidad.estado));
  } catch (err) { error($("#vt-err"), err.message); }
});

// ------------------------------------------------------------------ editar datos y referencia manual de la unidad
const CAMPOS_ED = ["pn_con_iva", "mercado_manual", "fuente_mercado_manual", "costo_compra", "reacondicionamiento", "costo_diario_manual",
  "costo_capital_manual", "costo_seguro_manual", "costo_espacio_manual", "costo_lavado_manual", "linea", "agencia", "placa"];
let edOrig = {};
function abrirEditar(enfocarReferencia) {
  const u = detU.unidad, f = $("#f-editar"), e = detU.evaluacion; f.reset();
  CAMPOS_ED.forEach(k => { f.elements[k].value = u[k] ?? ""; });
  edOrig = Object.fromEntries(CAMPOS_ED.map(k => [k, String(u[k] ?? "")]));
  $("#ed-sub").textContent = nombreVeh(u);
  $("#ed-pn-origen").textContent = u.pn_con_iva ? `(${u.pn_origen === "manual" ? "ingresado a mano" : u.pn_origen === "cotización" ? "cargado con la unidad" : "detectado"})` : "(sin dato)";
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
    await api(`/api/inventario/${detU.unidad.id}`, body);
    $("#m-editar").hidden = true; await recargarUnidad(); toast("Datos de la unidad actualizados");
  } catch (err) { error($("#ed-err"), err.message); }
});

// ------------------------------------------------------------------ tablero de objetivos
const fmtObj = (o, v) => v == null ? "–" : o.formato === "dias" ? v.toFixed(0) + " d" : o.formato === "usd" ? usdE(v) : (v * 100).toFixed(1).replace(".", ",") + " %";
const EST_OBJ = { ok: "Meta cumplida", cerca: "Cerca de la meta", lejos: "Lejos de la meta" };
async function cargarTablero() {
  let r;
  try { r = await api("/api/tablero"); } catch (e) { return toast("⚠️ " + esc(e.message)); }

  // A. ¿vamos a cumplir las metas? Tres grupos, uno por objetivo específico de la tesis
  const O = Object.fromEntries(r.objetivos.map(o => [o.clave, o]));
  const tarjeta = (o, extra = "") => {
    const av = o.avance, ancho = av == null ? 0 : Math.min(av, 1) * 100;
    return `<div class="obj-card ${o.estado || ""}"><h4>${esc(o.nombre)}</h4><div class="obj-valor">${fmtObj(o, o.valor)}</div>
      <div class="obj-metas"><span>Línea base<b>${o.base != null ? fmtObj(o, o.base) : "–"}</b></span><span>${o.control ? "Mínimo" : "Meta"}<b>${o.menos_es_mejor ? "≤ " : o.control ? "≥ " : ""}${fmtObj(o, o.meta)}</b></span></div>
      ${extra}
      <div class="obj-barra"><i style="width:${ancho}%"></i></div>
      <div class="obj-avance">${av == null ? "Sin datos todavía" : o.control ? (o.estado === "ok" ? "Cumple el mínimo" : "Por debajo del mínimo") : `${EST_OBJ[o.estado]} · ${Math.round(av * 100)} %`}</div>
      <div class="obj-det">${esc(o.detalle)}</div></div>`;
  };
  const mini = (titulo, valor, detalle) => `<div class="obj-card mini"><h4>${titulo}</h4><div class="obj-valor">${valor}</div><div class="obj-det">${detalle}</div></div>`;
  const reg = O.regla, ben = O.beneficio;
  const dividido = (nombre, valor, meta) => `<div class="obj-split"><span>${nombre}</span><b>${fmtObj(ben, valor)}</b><small>meta ${fmtObj(ben, meta)}</small></div>`;
  const cuerpo = {
    1: [O.dias, O.mas120, O.margen_bruto, O.margen_rescatadas].map(o => tarjeta(o)).join(""),
    2: tarjeta(reg) + mini("Excepciones de este mes", reg.excepciones_mes ?? "–", "cambios de precio fuera de la banda; los que siguen sin aprobar cuentan como fuera de la regla")
       + mini("Próximo comité de precios", reg.proximo_comite ? diaF(reg.proximo_comite) : "–", "el comité se reúne una vez al mes"),
    3: tarjeta(ben, `<div class="obj-splits">${dividido("Margen recuperado", ben.margen, ben.meta_margen)}${dividido("Capital evitado", ben.capital_evitado, ben.meta_capital)}</div><div class="obj-det">Valores al año. ${esc(ben.nota)}</div>`)
       + tarjeta(O.capital, `<div class="obj-det">Valores al año. Unidades rescatadas del año 1: ${O.capital.meta_unidades.toFixed(0)}.</div>`),
  };
  $("#t-obj").innerHTML = r.grupos.map(g => `<section class="obj-grupo">
    <div class="obj-grupo-head"><span class="obj-num">${g.grupo}</span><div><h4>Objetivo ${g.grupo} · ${esc(g.titulo)} <small>(${esc(g.plazo)})</small></h4><p>${esc(g.texto)}</p></div></div>
    <div class="obj-grid g${g.grupo}">${cuerpo[g.grupo]}</div>
    ${g.grupo === 3 ? `<p class="obj-2030">${esc(ben.nota_2030)}</p>` : ""}</section>`).join("");

  // B. revisión semanal del jefe de pricing
  const d = r.decisiones;
  $("#t-pend").textContent = d.length ? `${d.length} ${d.length === 1 ? "decisión pendiente" : "decisiones pendientes"} en la revisión semanal` : "Sin decisiones pendientes en la revisión semanal";
  $("#t-sem").innerHTML = ["rojo", "naranja", "amarillo", "verde"].map(s => `<span>${semDot(s)} ${r.semaforos[s]} ${SEM[s].toLowerCase()}</span>`).join("");
  $("#t-dec-vacio").hidden = d.length > 0; $("#t-dec-tabla").hidden = !d.length;
  $("#t-dec").innerHTML = d.map(x => `<tr class="clic" data-id="${x.id}"><td>${semDot(x.semaforo)}</td>
    <td><b>${esc(nombreVeh(x))}</b><small>${esc(x.linea)} · ${esc(x.agencia || "–")}</small></td><td class="num">${x.dias}</td>
    <td class="num">${usdE(x.precio_publicado)}</td><td class="num"><b>${usdE(x.sugerido)}</b></td>
    <td>${recPill(x.recomendacion)}<small class="rec-txt">${esc(x.texto)}</small></td>
    <td>${casoPill(x.caso, x.caso_nombre)} <small class="rec-txt"><b>${esc(x.estado)}</b> · ${esc(x.accion_comercial)}</small></td>
    <td><ul class="motivos">${x.motivos.map(m => `<li>${esc(m)}</li>`).join("")}</ul></td>
    <td class="num"><div class="btns-dec"><button class="btn btn-pri btn-mini" data-aplicar="${x.id}">${x.igual ? "Confirmar revisión" : "Aplicar sugerido"}</button>
      <button class="btn btn-ghost btn-mini" data-mantener="${x.id}" data-nombre="${esc(nombreVeh(x))}" data-pub="${x.precio_publicado}" data-sug="${Math.round(x.sugerido)}">Mantener con motivo</button></div></td></tr>`).join("");

  // C. ¿dónde está el dinero?
  const m = r.dinero, antiguas = r.limite_antiguas;
  $("#t-kpis").innerHTML = [
    ["Capital inmovilizado", usdE(m.capital_inmovilizado), `${m.unidades} unidades en piso (compra + reacondicionamiento)`],
    ["Costo diario de tener el inventario", usdE(m.costo_diario_total), "12 % anual de capital sobre todas las unidades (más costos adicionales si están activados)"],
    [`Costo acumulado de las de más de ${antiguas} días`, usdE(m.costo_acumulado_mas_120), `${m.n_mas_120} unidad${m.n_mas_120 === 1 ? "" : "es"} que ya pasaron el límite`],
    ["Utilidad potencial", usdE(m.utilidad_potencial), "precio publicado − costo acumulado"],
    ["Días promedio de lo que hay en piso", m.dias_promedio == null ? "–" : m.dias_promedio.toFixed(0), "unidades en piso o reservadas"],
    ["Más de " + antiguas + " días", m.pct_mas_120 == null ? "–" : (m.pct_mas_120 * 100).toFixed(1).replace(".", ",") + " %", "de las unidades en piso"],
  ].map(([t, v, s]) => `<div class="kpi"><small>${t}</small><b>${v}</b><span>${s}</span></div>`).join("");
  // valores escritos sobre las barras; el color solo marca el estado del tramo (mismos colores del semáforo)
  const valoresBarras = { id: "valoresBarras", afterDatasetsDraw(ch) { const { ctx } = ch; ctx.save(); ctx.font = "700 12px Inter, sans-serif"; ctx.fillStyle = "#240078"; ctx.textAlign = "center";
    const ds = ch.data.datasets[0]; ch.getDatasetMeta(0).data.forEach((b, i) => ctx.fillText(ds.fmtCorto(ds.data[i]), b.x, b.y - 6)); ctx.restore(); } };
  const barra = (id, datos, colores, fmt, fmtCorto) => grafico(id, { type: "bar", plugins: [valoresBarras], data: { labels: r.tramos.map(t => t + " d"), datasets: [{ data: datos, backgroundColor: colores, borderRadius: 6, maxBarThickness: 54, fmtCorto }] },
    options: { responsive: true, maintainAspectRatio: false, layout: { padding: { top: 18 } }, plugins: { legend: { display: false },
      tooltip: { backgroundColor: C.deep, displayColors: false, callbacks: { label: it => fmt(it.parsed.y) } } },
      scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grace: "12%", ticks: { precision: 0, maxTicksLimit: 5, callback: v => fmtCorto(v) }, grid: { color: C.line } } } } });
  const col = ["#10B981", "#10B981", "#F59E0B", "#F97316", "#EF4444"];
  const capVieja = m.capital_por_tramo[r.tramos[4]], capTot = m.capital_inmovilizado;
  $("#t-tit-tramos").textContent = m.unidades ? `${m.n_mas_120} de ${m.unidades} unidades en inventario pasan de ${antiguas} días` : "Unidades por tramo de días";
  $("#t-tit-capital").textContent = capTot ? `${(capVieja / capTot * 100).toFixed(0)} % del capital (${usdE(capVieja)}) está en unidades de más de ${antiguas} días` : "Capital invertido por tramo de días";
  barra("ch-tramos", r.tramos.map(t => m.por_tramo[t]), col, v => v + (v === 1 ? " unidad" : " unidades"), v => String(v));
  barra("ch-capital", r.tramos.map(t => m.capital_por_tramo[t]), col, v => usdE(v), v => v >= 1000 ? "$" + Math.round(v / 1000) + " mil" : usdE(v));

  // excepciones
  const pe = x => x.aprobado === 1 ? `<span class="pill a-si">Aprobada</span>` : x.aprobado === 0 ? `<span class="pill a-no">Rechazada</span>` : `<span class="pill a-pend">Pendiente</span>`;
  const co = r.comite;
  $("#t-com-sub").textContent = `El comité de precios se reúne una vez al mes: revisa las excepciones y las unidades que cruzaron el día 90. Próxima sesión: ${diaF(co.fecha)} (día ${co.dia_comite} de cada mes; editable en Parámetros).`;
  $("#t-com-head").textContent = `${co.excepciones_mes} ${co.excepciones_mes === 1 ? "excepción" : "excepciones"} este mes · ${co.pasaron_90.length} ${co.pasaron_90.length === 1 ? "unidad pasó" : "unidades pasaron"} el día 90 · comité el ${diaF(co.fecha)}`;
  $("#t-c90-vacio").hidden = co.pasaron_90.length > 0; $("#t-c90-tabla").hidden = !co.pasaron_90.length;
  $("#t-c90").innerHTML = co.pasaron_90.map(x => `<tr class="clic" data-id="${x.id}"><td>${semDot(x.semaforo)}</td><td><b>${esc(nombreVeh(x))}</b><small>${esc(x.linea)} · ${esc(x.agencia || "–")}</small></td>
    <td class="num">${x.dias}</td><td class="nw">${diaF(x.cruce)}</td><td class="num">${usdE(x.precio_publicado)}</td><td class="num"><b>${usdE(x.sugerido)}</b></td><td>${recPill(x.recomendacion)}</td></tr>`).join("");
  $("#t-exc-sub").textContent = `Cambios de precio de este mes que quedaron fuera de la banda de negociación (mínimo – máximo), más los que siguen sin aprobar. Una excepción sin aprobar cuenta como fuera de la regla.`;
  $("#t-exc-vacio").hidden = r.excepciones.length > 0;
  $("#t-exc").innerHTML = r.excepciones.map(x => { const dd = x.precio_nuevo / x.precio_sugerido - 1;
    return `<tr class="clic" data-id="${x.unidad_id}"><td class="nw">${fechaCorta(x.fecha)}</td><td>${esc(x.vehiculo || "–")}<small>${esc(x.placa || "")}</small></td>
    <td class="num">${usdE(x.precio_sugerido)}</td><td class="num"><b>${usdE(x.precio_nuevo)}</b></td><td class="num ${dd > 0 ? "up" : "down"}">${pctE(dd, 1)}</td>
    <td>${esc(x.motivo || "–")}</td><td>${esc(x.nombre_usuario || x.usuario)}</td>
    <td class="nw">${pe(x)}${YO.rol === "admin" && x.aprobado == null ? `<div class="btns-dec" style="margin-top:6px"><button class="btn btn-pri btn-mini" data-aprobar="${x.id}">Aprobar</button><button class="btn btn-ghost btn-mini" data-rechazar="${x.id}">Rechazar</button></div>` : ""}</td></tr>`; }).join("");
}

let mantener = null, mantenerDesdeCalc = false;
document.querySelector('[data-vista="tablero"]').addEventListener("click", async e => {
  const b = e.target.closest("[data-aplicar]"), mt = e.target.closest("[data-mantener]"), ap = e.target.closest("[data-aprobar],[data-rechazar]");
  if (b) {
    b.disabled = true;
    try { await api(`/api/inventario/${b.dataset.aplicar}/precio`, { aplicar_sugerido: true }); toast("Revisión registrada"); cargarTablero(); }
    catch (err) { toast("⚠️ " + esc(err.message)); b.disabled = false; }
    return;
  }
  if (mt) {
    mantener = mt.dataset.mantener; mantenerDesdeCalc = false; $("#f-mantener").reset(); error($("#mt-err"), "");
    $("#mt-sub").innerHTML = `<b>${mt.dataset.nombre}</b>: se mantiene en ${usdE(+mt.dataset.pub)} aunque el sugerido es ${usdE(+mt.dataset.sug)}. Queda como excepción para que el administrador la apruebe.`;
    $("#m-mantener").hidden = false; return;
  }
  if (ap) {
    ap.disabled = true;
    try { await api(`/api/precios/${ap.dataset.aprobar || ap.dataset.rechazar}/aprobar`, { aprobar: !!ap.dataset.aprobar }); toast(ap.dataset.aprobar ? "Excepción aprobada" : "Excepción rechazada"); cargarTablero(); }
    catch (err) { toast("⚠️ " + esc(err.message)); ap.disabled = false; }
    return;
  }
  const tr = e.target.closest("tr[data-id]"); if (tr) location.hash = "#/calculadora/" + tr.dataset.id;
});
$("#f-mantener").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await api(`/api/inventario/${mantener}/precio`, { mantener: true, motivo: e.target.elements.motivo.value });
    $("#m-mantener").hidden = true; toast("Revisión registrada con su motivo");
    if (mantenerDesdeCalc) { mantenerDesdeCalc = false; await recargarUnidad(); } else cargarTablero();
  } catch (err) { error($("#mt-err"), err.message); }
});

// ------------------------------------------------------------------ parámetros (admin)
let paramDef = null;
const PARAM_COSTOS = ["tasa_capital_anual", "tasa_seguro_anual", "costo_espacio_diario", "costo_lavado_diario"];

// etiqueta "Supuesto — reemplazar con dato de 1001Carros" junto a cada costo + los dos ejemplos calculados en vivo
function pintarCostosEjemplo() {
  const f = $("#f-param").elements, n = k => (+f[k].value || 0), on = f.costos_adicionales.checked;
  PARAM_COSTOS.forEach(k => { const t = $(`[data-tag="${k}"]`); t.className = "tag-fuente " + f["fuente_" + k].value; t.textContent = FUENTE_TXT[f["fuente_" + k].value]; });
  ["seguro", "espacio", "lavado"].forEach(c => { $(`.cparam[data-c="${c}"]`).classList.toggle("inactivo", !on); });
  ["tasa_seguro_anual", "costo_espacio_diario", "costo_lavado_diario", "fuente_tasa_seguro_anual", "fuente_costo_espacio_diario", "fuente_costo_lavado_diario"].forEach(k => f[k].disabled = !on);
  const filas = [["Capital", b => Math.round(b * n("tasa_capital_anual") / 365) / 100, "tasa_capital_anual"]];       // a centavos, como en el business case
  if (on) filas.push(["Seguro", b => Math.round(b * n("tasa_seguro_anual") / 365) / 100, "tasa_seguro_anual"],
    ["Espacio en patio", () => n("costo_espacio_diario"), "costo_espacio_diario"], ["Lavado y mantenimiento", () => n("costo_lavado_diario"), "costo_lavado_diario"]);
  const bases = [15715, 76500];
  const tot = bases.map(b => filas.reduce((s, [, fn]) => s + fn(b), 0));
  $("#par-costos tbody").innerHTML = filas.map(([t, fn]) => `<tr><td>${t}</td>${bases.map(b => `<td class="num">${usd2E(fn(b))}</td>`).join("")}</tr>`).join("")
    + `<tr class="total"><td><b>Total por día</b></td>${tot.map(v => `<td class="num"><b>${usd2E(v)}</b></td>`).join("")}</tr>`
    + `<tr><td>A 90 días</td>${bases.map((b, i) => `<td class="num">${usdE(b + 90 * tot[i])}<small>costo acumulado</small></td>`).join("")}</tr>`;
}
// metas calculadas con los supuestos: misma cuenta del modelo financiero (inventario.business_case); redondea por unidad (USD 595 y 695)
function businessCaseJS(anio) {
  const f = $("#f-param").elements, n = k => +f[k].value, pc = k => n(k) / 100;
  const ventas = n("ventas_2025") * (1 + pc("crecimiento_ventas")) ** anio, resc = ventas * pc("base_pct_mas_120") * pc("proporcion_rescatada");
  const mz = pc("mezcla_61_90"), margenResc = mz * pc("margen_61_90") + (1 - mz) * pc("margen_91_120");
  const margenU = Math.round((margenResc - pc("margen_espera")) * n("precio_referencia"));
  const dias = n("dias_espera") - (mz * n("base_dias_promedio") + (1 - mz) * n("dia_venta_91_120"));
  const diario = Math.round(n("costo_referencia") * pc("tasa_capital_anual") / 365 * 100) / 100, capU = Math.round(diario * dias);
  return { resc, margenResc, margenU, capU, benU: margenU + capU, dias, margen: resc * margenU, capital: resc * capU, beneficio: resc * (margenU + capU),
           liberado: resc * n("costo_referencia") * dias / 365 };
}
function pintarBusinessCase() {
  const a = businessCaseJS(1), z = businessCaseJS(+$("#f-param").elements.anio_referencia.value || 5);
  const fila = (t, v, s = "") => `<tr><td>${t}${s ? `<small>${s}</small>` : ""}</td><td class="num"><b>${v}</b></td></tr>`;
  $("#par-bc tbody").innerHTML =
    fila("Unidades rescatadas (año 1)", a.resc.toFixed(1).replace(".", ","), "ventas × % pasan de 120 d × % rescatada") +
    fila("Margen de una rescatada", pct1(a.margenResc), "mezcla de los tramos 61–90 y 91–120") +
    fila("Margen recuperado por unidad", usdE(a.margenU), "(margen rescatada − margen después de 120 d) × precio de referencia") +
    fila("Días de capital evitados", a.dias.toFixed(1).replace(".", ","), "días promedio después de 120 − día promedio de venta") +
    fila("Capital evitado por unidad", usdE(a.capU), "costo diario × días evitados") +
    fila("Beneficio por unidad rescatada", usdE(a.benU), "margen recuperado + capital evitado") +
    fila("Meta de beneficio anual", usdE(a.beneficio), `margen ${usdE(a.margen)} + capital ${usdE(a.capital)}`) +
    fila("Meta de capital liberado", usdE(a.liberado), "rescatadas × costo de referencia × días evitados ÷ 365") +
    fila(`Referencia ${2025 + (+$("#f-param").elements.anio_referencia.value || 5)} (informativa)`, `${usdE(z.beneficio)} · ${usdE(z.liberado)}`, "beneficio · capital liberado");
}
$("#f-param").addEventListener("input", () => { pintarCostosEjemplo(); pintarBusinessCase(); });
$("#f-param").elements.costos_adicionales.addEventListener("change", e => {
  const f = $("#f-param").elements, ej = paramDef && paramDef.__ej;
  if (e.target.checked && ej && !(+f.tasa_seguro_anual.value || +f.costo_espacio_diario.value || +f.costo_lavado_diario.value)) {      // se proponen los supuestos de antes
    f.tasa_seguro_anual.value = +(ej.tasa_seguro_anual * 100).toFixed(2); f.costo_espacio_diario.value = ej.costo_espacio_diario; f.costo_lavado_diario.value = ej.costo_lavado_diario;
  }
  pintarCostosEjemplo();
});

function llenarParametros(p) {
  const f = $("#f-param").elements, t = p.tramos;
  f.tasa_capital_anual.value = +(p.tasa_capital_anual * 100).toFixed(2); f.tasa_seguro_anual.value = +(p.tasa_seguro_anual * 100).toFixed(2);
  f.costo_espacio_diario.value = p.costo_espacio_diario; f.costo_lavado_diario.value = p.costo_lavado_diario;
  f.costos_adicionales.checked = !!p.costos_adicionales;
  PARAM_COSTOS.forEach(k => { f["fuente_" + k].value = p.fuentes[k]; });
  const pc = v => +(v * 100).toFixed(2);
  f.margen_minimo.value = pc(p.margen_minimo); f.banda_negociacion.value = pc(p.banda_negociacion);
  [0, 1, 2, 3, 4].forEach(i => { f["m" + i].value = pc(p.margenes[i]); f["tp" + i].value = pc(p.topes[i]); });
  [0, 1].forEach(i => { f["su" + i].value = p.stock_umbrales[i]; f["sa" + i].value = pc(p.stock_ajustes[i]); });
  f.dias_espera.value = p.dias_espera; f.margen_espera.value = pc(p.margen_espera);
  f.base_dias_promedio.value = p.base_dias_promedio; f.meta_dias.value = p.meta_dias;
  f.base_pct_mas_120.value = pc(p.base_pct_mas_120); f.meta_pct_mas_120.value = pc(p.meta_pct_mas_120); f.margen_bruto_minimo.value = pc(p.margen_bruto_minimo);
  f.base_pct_en_regla.value = pc(p.base_pct_en_regla); f.meta_pct_en_regla.value = pc(p.meta_pct_en_regla); f.dia_comite_mes.value = p.dia_comite_mes;
  f.ventas_2025.value = p.ventas_2025; f.crecimiento_ventas.value = +(p.crecimiento_ventas * 100).toFixed(6);       // 5,921317 %: el Excel usa el valor exacto
  f.proporcion_rescatada.value = pc(p.proporcion_rescatada); f.margen_61_90.value = pc(p.margen_61_90); f.margen_91_120.value = pc(p.margen_91_120);
  f.mezcla_61_90.value = pc(p.mezcla_61_90); f.dia_venta_91_120.value = p.dia_venta_91_120; f.anio_referencia.value = p.anio_referencia;
  f.precio_referencia.value = p.precio_referencia; f.costo_referencia.value = p.costo_referencia;
  pintarCostosEjemplo(); pintarBusinessCase();
  t.forEach((x, i) => f["t" + i].value = x);
  f.dias_revision.value = p.dias_revision; f.tolerancia_banda.value = +(p.tolerancia_banda * 100).toFixed(2);
}
function leerParametros() {
  const f = $("#f-param").elements, n = k => +f[k].value;
  return { tasa_capital_anual: n("tasa_capital_anual") / 100, costos_adicionales: f.costos_adicionales.checked, tasa_seguro_anual: n("tasa_seguro_anual") / 100,
    costo_espacio_diario: n("costo_espacio_diario"), costo_lavado_diario: n("costo_lavado_diario"),
    fuentes: Object.fromEntries(PARAM_COSTOS.map(k => [k, f["fuente_" + k].value])),
    base_dias_promedio: n("base_dias_promedio"), meta_dias: n("meta_dias"), base_pct_mas_120: n("base_pct_mas_120") / 100,
    meta_pct_mas_120: n("meta_pct_mas_120") / 100, margen_bruto_minimo: n("margen_bruto_minimo") / 100,
    base_pct_en_regla: n("base_pct_en_regla") / 100, meta_pct_en_regla: n("meta_pct_en_regla") / 100, dia_comite_mes: n("dia_comite_mes"),
    ventas_2025: n("ventas_2025"), crecimiento_ventas: n("crecimiento_ventas") / 100, proporcion_rescatada: n("proporcion_rescatada") / 100,
    margen_61_90: n("margen_61_90") / 100, margen_91_120: n("margen_91_120") / 100, mezcla_61_90: n("mezcla_61_90") / 100,
    dia_venta_91_120: n("dia_venta_91_120"), anio_referencia: n("anio_referencia"), precio_referencia: n("precio_referencia"), costo_referencia: n("costo_referencia"),
    margen_minimo: n("margen_minimo") / 100, banda_negociacion: n("banda_negociacion") / 100, dias_revision: n("dias_revision"),
    tramos: [0, 1, 2, 3].map(i => n("t" + i)), margenes: [0, 1, 2, 3, 4].map(i => n("m" + i) / 100), topes: [0, 1, 2, 3, 4].map(i => n("tp" + i) / 100),
    stock_umbrales: [n("su0"), n("su1")], stock_ajustes: [n("sa0") / 100, n("sa1") / 100],
    dias_espera: n("dias_espera"), margen_espera: n("margen_espera") / 100,
    tolerancia_banda: n("tolerancia_banda") / 100 };
}

async function cargarParametros() {
  error($("#par-err"), "");
  try {
    const [r, l] = await Promise.all([api("/api/parametros"), api("/api/inventario?estado=En piso")]);
    paramDef = { ...r.por_defecto, __ej: r.adicionales_ejemplo }; llenarParametros(r.parametros);
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

// ================================================================== PRUEBAS CON USUARIOS (validación del prototipo)
let PR = null;
function armarPruebas(r) {
  const f = $("#f-prueba"); if (f.dataset.listo) return; f.dataset.listo = "1";
  f.elements.perfil.innerHTML = `<option value="">Elegir…</option>` + r.perfiles.map(x => `<option>${esc(x)}</option>`).join("");
  f.elements.dispositivo.innerHTML = r.dispositivos.map(x => `<option>${esc(x)}</option>`).join("");
  f.elements.dispositivo.value = window.matchMedia("(max-width: 760px)").matches ? "Celular" : "Computadora";
  $("#pr-vendible").innerHTML = Object.entries(r.vendible).map(([k, t]) => `<label><input type="radio" name="vendible" value="${k}" required><span>${esc(t)}</span></label>`).join("");
  $$(".escala", f).forEach(d => d.innerHTML = [1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="${d.dataset.n}" value="${n}"><span>${n}</span></label>`).join(""));
}
async function cargarPruebas() {
  try { PR = await api("/api/pruebas"); } catch (e) { return toast("⚠️ " + esc(e.message)); }
  armarPruebas(PR);
  $("#pr-ver").textContent = `Versión del prototipo: ${PR.version}. La fecha se guarda sola.`;
  // selector de carros del inventario (con el precio sugerido de hoy para llenarlo solo)
  try {
    const inv = await api("/api/inventario?estado=En piso"), sel = $("#f-prueba").elements.unidad_id, cur = sel.value;
    sel.innerHTML = `<option value="">Otro (escríbelo abajo)</option>` + inv.unidades.map(u => `<option value="${u.id}" data-sug="${Math.round(u.sugerido || 0)}">${esc(nombreVeh(u))} · ${u.dias} d · sugerido ${usdE(u.sugerido)}</option>`).join("");
    sel.value = cur;
  } catch (_) { /* sin inventario se escribe el carro a mano */ }
  const est = { cumple: ["ok", "Se cumple"], no_cumple: ["lejos", "No se cumple todavía"] };
  $("#pr-hip").innerHTML = PR.resumen.map(h => { const [c, t] = est[h.estado] || ["", "Sin datos todavía"];
    return `<div class="obj-card ${c}"><h4>${h.clave}</h4><p class="hip-txt">${esc(h.texto)}</p>
      <div class="obj-valor">${h.valor == null ? "–" : (h.valor * 100).toFixed(0) + " %"}</div>
      <div class="obj-barra"><i style="width:${h.valor == null ? 0 : Math.min(h.valor / h.meta, 1) * 100}%"></i></div>
      <div class="obj-avance">${t} · meta ${(h.meta * 100).toFixed(0)} %</div>
      <div class="obj-det">${h.cumplen} de ${h.n} ${esc(h.que)}</div></div>`; }).join("");
  $("#pr-n").textContent = `Pruebas registradas (${PR.pruebas.length})`;
  $("#pr-vacio").hidden = PR.pruebas.length > 0;
  $("#pr-tabla").innerHTML = PR.pruebas.map(p => `<tr><td class="nw">${fechaCorta(p.fecha)}</td>
    <td><b>${esc(p.participante)}</b><small>${esc(p.perfil)}${p.ciudad ? " · " + esc(p.ciudad) : ""} · ${esc(p.dispositivo || "–")}</small></td>
    <td>${esc(p.carro)}${p.comentarios ? `<small class="rec-txt">${esc(p.comentarios)}</small>` : ""}</td>
    <td class="num">${usdE(p.precio_sugerido)}</td><td><span class="pill v-${p.vendible}">${esc(PR.vendible[p.vendible] || p.vendible)}</span></td>
    <td class="num">${usdE(p.precio_pondria)}</td><td class="num ${p.segundos != null && p.segundos >= 60 ? "down" : ""}">${p.segundos ?? "–"}</td>
    <td class="num">${p.utilidad ?? "–"} / ${p.facilidad ?? "–"}</td>
    <td>${YO.rol === "admin" ? `<button class="btn btn-ghost btn-mini" data-borrar-prueba="${p.id}">Borrar</button>` : ""}</td></tr>`).join("");
}
$("#f-prueba").elements.unidad_id.addEventListener("change", e => {
  const o = e.target.selectedOptions[0], f = $("#f-prueba").elements;
  if (o && o.dataset.sug && +o.dataset.sug) f.precio_sugerido.value = o.dataset.sug;
  if (e.target.value) f.carro.value = "";
});
$("#f-prueba").addEventListener("submit", async e => {
  e.preventDefault();
  const d = Object.fromEntries([...new FormData(e.target)].filter(([, v]) => v !== ""));
  d.version = PR ? PR.version : "";
  try {
    await api("/api/pruebas", d);
    const disp = e.target.elements.dispositivo.value; e.target.reset(); e.target.elements.dispositivo.value = disp;
    error($("#pr-f-err"), ""); toast("Prueba guardada"); cargarPruebas();
  } catch (err) { error($("#pr-f-err"), err.message); }
});
$("#pr-tabla").addEventListener("click", async e => {
  const b = e.target.closest("[data-borrar-prueba]"); if (!b) return;
  if (!confirm("¿Borrar esta prueba? No se puede deshacer.")) return;
  try { await api(`/api/pruebas/${b.dataset.borrarPrueba}/borrar`, {}); toast("Prueba borrada"); cargarPruebas(); }
  catch (err) { toast("⚠️ " + esc(err.message)); }
});

// ================================================================== NOTA PARA EL COMITÉ (plantilla, sin servicios externos)
function notaComite() {
  const { unidad: u, evaluacion: e } = det, c = e.caminos, conf = e.confianza || {};
  const usd = v => (v < 0 ? "-USD " : "USD ") + Math.abs(Math.round(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const pct = v => v == null ? "–" : (v * 100).toFixed(1).replace(".", ",") + " %";
  const b = Object.fromEntries(e.banda.map(x => [x.clave, x]));
  const l = [
    `NOTA PARA EL COMITÉ DE PRECIOS · ${diaF(hoyISO())}`,
    `Unidad: ${nombreVeh(u)}${u.placa ? " · placa " + u.placa : ""} · ${u.linea} · ${u.agencia || "sin agencia"}`,
    `Días en inventario: ${e.dias} (tramo ${e.tramo_nombre} días, estado ${e.estado})`,
    `Caso de la regla: ${e.caso_nombre}. ${e.frase_caso}`,
    `Mercado: ${usd(e.mercado)} (rango ${usd(e.bajo50)} – ${usd(e.alto50)})${e.referencia_manual ? " · referencia manual: " + (u.fuente_mercado_manual || "") : ""} · confianza ${conf.nivel || "–"}`,
    `Costo acumulado: ${usd(e.costo_acumulado)} (${usd(e.costo_base)} de compra y reacondicionamiento + ${e.dias} días × ${usd2E(e.costo_diario).replace("$", "USD ")})`,
    ...(cal.unidadId || cal.anuncio ? [`Precio publicado hoy: ${usd(u.precio_publicado)}`] : []),
    `Banda: mínimo ${usd(b.minimo.precio)} (${pct(b.minimo.pct)}) · objetivo ${usd(b.objetivo.precio)} (${pct(b.objetivo.pct)}) · máximo ${usd(b.maximo.precio)} (${pct(b.maximo.pct)})`,
    `Camino 1, vender hoy: ${usd(c.vender_hoy)}. Camino 2, ${c.modo === "espera_larga" ? "esperar hasta el día " + c.hasta_dia : "esperar 30 días más"}: ${usd(c.esperar)}. Diferencia a favor de ${c.diferencia >= 0 ? "vender hoy" : "esperar"}: ${usd(Math.abs(c.diferencia))}.`,
    `Acción recomendada: ${e.recomendacion} a ${usd(e.sugerido)}. ${e.accion_comercial}`,
  ];
  return l.join("\n");
}
async function copiarTexto(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (_) {
    const ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch (_) {} ta.remove(); return ok;
  }
}
$("#un-nota").addEventListener("click", async () => {
  if (!det || det.vendida) return toast("La nota es para carros en inventario");
  const t = notaComite();
  toast(await copiarTexto(t) ? "Nota copiada: pégala en el correo o el chat del comité" : "No se pudo copiar: el texto quedó en la consola");
  if (!navigator.clipboard) console.log(t);
});
