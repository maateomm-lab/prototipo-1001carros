"""Usuarios, sesiones y cotizaciones guardadas (SQLite, viene con Python).

El archivo de datos queda en  web/datos_app/cotizador.db.  Para respaldar todo basta copiar esa carpeta.
"""
import hashlib
import json
import os
import secrets
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

DB = Path(os.environ.get("COTIZADOR_DB") or Path(__file__).resolve().parent / "datos_app" / "cotizador.db")
DIAS_SESION = 7
ESTADOS = ["Cotizada", "En negociación", "Comprada", "Perdida"]
ROLES = ["asesor", "admin"]
CAMPOS_CLIENTE = ["cliente", "telefono", "correo", "placa", "color", "notas"]


def con():
    c = sqlite3.connect(DB, timeout=10)
    c.row_factory = sqlite3.Row
    return c


def ahora():
    return datetime.now().isoformat(timespec="seconds")


COLUMNAS_NUEVAS = {
    "inventario": dict(pn_origen="TEXT", costo_diario_manual="REAL", costo_capital_manual="REAL",
                       costo_seguro_manual="REAL", costo_espacio_manual="REAL", costo_lavado_manual="REAL",
                       mercado_manual="REAL", fuente_mercado_manual="TEXT", usuario_mercado_manual="TEXT",
                       fecha_mercado_manual="TEXT"),
    "precios_inventario": dict(aprobado="INTEGER", aprobado_por="TEXT", aprobado_fecha="TEXT"),
}


def crear_tablas():
    DB.parent.mkdir(exist_ok=True)
    with con() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS usuarios(
            usuario TEXT PRIMARY KEY, nombre TEXT NOT NULL, rol TEXT NOT NULL, sal TEXT NOT NULL, hash TEXT NOT NULL,
            activo INTEGER NOT NULL DEFAULT 1, creado TEXT);
        CREATE TABLE IF NOT EXISTS sesiones(token TEXT PRIMARY KEY, usuario TEXT NOT NULL, creada TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cotizaciones(
            id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL, actualizada TEXT, usuario TEXT NOT NULL,
            estado TEXT NOT NULL, cliente TEXT, telefono TEXT, correo TEXT, placa TEXT, color TEXT, notas TEXT,
            vehiculo TEXT, marca TEXT, anio INTEGER, km REAL, mercado REAL, bajo50 REAL, alto50 REAL,
            margen REAL, oferta REAL, oferta_final REAL, confianza TEXT, datos TEXT);
        CREATE INDEX IF NOT EXISTS ix_cot_fecha ON cotizaciones(fecha);
        CREATE TABLE IF NOT EXISTS inventario(
            id INTEGER PRIMARY KEY AUTOINCREMENT, cotizacion_id INTEGER, vehiculo TEXT, marca TEXT NOT NULL,
            familia TEXT NOT NULL, version TEXT, modelo TEXT, anio INTEGER NOT NULL, km REAL, cilindraje REAL,
            subtipo TEXT, transmision TEXT, combustible TEXT, traccion TEXT, ciudad TEXT, provincia_placa TEXT,
            vendedor_tipo TEXT, climatizacion TEXT, tapizado TEXT, direccion TEXT, vidrios TEXT, pn_con_iva REAL,
            placa TEXT, color TEXT, linea TEXT NOT NULL DEFAULT '1001', agencia TEXT, fecha_ingreso TEXT NOT NULL,
            costo_compra REAL NOT NULL, reacondicionamiento REAL NOT NULL DEFAULT 0, precio_publicado REAL NOT NULL,
            estado TEXT NOT NULL DEFAULT 'En piso', fecha_venta TEXT, precio_venta REAL, ultima_revision TEXT,
            creado_por TEXT, creado TEXT, demo INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS ix_inv_estado ON inventario(estado);
        CREATE TABLE IF NOT EXISTS precios_inventario(
            id INTEGER PRIMARY KEY AUTOINCREMENT, unidad_id INTEGER NOT NULL, fecha TEXT NOT NULL,
            precio_anterior REAL, precio_nuevo REAL NOT NULL, precio_sugerido REAL, motivo TEXT, usuario TEXT);
        CREATE INDEX IF NOT EXISTS ix_precios_unidad ON precios_inventario(unidad_id);
        CREATE TABLE IF NOT EXISTS parametros(
            id INTEGER PRIMARY KEY CHECK (id = 1), datos TEXT NOT NULL, actualizado TEXT, usuario TEXT);
        CREATE TABLE IF NOT EXISTS referencias_mercado(
            id INTEGER PRIMARY KEY AUTOINCREMENT, unidad_id INTEGER NOT NULL, fecha TEXT NOT NULL, valor REAL,
            fuente TEXT, usuario TEXT, valor_modelo REAL);
        CREATE INDEX IF NOT EXISTS ix_ref_unidad ON referencias_mercado(unidad_id);
        """)
        # Columnas agregadas después de la primera versión: se añaden sin tocar los datos que ya existen.
        for tabla, cols in COLUMNAS_NUEVAS.items():
            tiene = {r["name"] for r in c.execute(f"PRAGMA table_info({tabla})")}
            for nombre, tipo in cols.items():
                if nombre not in tiene:
                    c.execute(f"ALTER TABLE {tabla} ADD COLUMN {nombre} {tipo}")


# ----------------------------------------------------------------------------- usuarios y sesiones
def _hash(clave, sal):
    return hashlib.pbkdf2_hmac("sha256", clave.encode(), bytes.fromhex(sal), 200_000).hex()


def hay_usuarios():
    with con() as c:
        return c.execute("SELECT COUNT(*) FROM usuarios").fetchone()[0] > 0


def _publico(r):
    return dict(usuario=r["usuario"], nombre=r["nombre"], rol=r["rol"], activo=bool(r["activo"]))


def crear_usuario(usuario, nombre, clave, rol="asesor"):
    usuario = (usuario or "").strip().lower()
    if not usuario or not (nombre or "").strip():
        raise ValueError("Usuario y nombre son obligatorios")
    if len(clave or "") < 6:
        raise ValueError("La contraseña debe tener al menos 6 caracteres")
    if rol not in ROLES:
        raise ValueError("Rol no válido")
    sal = secrets.token_hex(16)
    try:
        with con() as c:
            c.execute("INSERT INTO usuarios(usuario, nombre, rol, sal, hash, creado) VALUES (?,?,?,?,?,?)",
                      (usuario, nombre.strip(), rol, sal, _hash(clave, sal), ahora()))
    except sqlite3.IntegrityError:
        raise ValueError(f"El usuario '{usuario}' ya existe")
    return dict(usuario=usuario, nombre=nombre.strip(), rol=rol, activo=True)


def modificar_usuario(usuario, clave=None, rol=None, activo=None, nombre=None):
    with con() as c:
        if not c.execute("SELECT 1 FROM usuarios WHERE usuario=?", (usuario,)).fetchone():
            raise ValueError("Usuario no encontrado")
        if clave is not None:
            if len(clave) < 6:
                raise ValueError("La contraseña debe tener al menos 6 caracteres")
            sal = secrets.token_hex(16)
            c.execute("UPDATE usuarios SET sal=?, hash=? WHERE usuario=?", (sal, _hash(clave, sal), usuario))
            c.execute("DELETE FROM sesiones WHERE usuario=?", (usuario,))
        if rol is not None:
            if rol not in ROLES:
                raise ValueError("Rol no válido")
            c.execute("UPDATE usuarios SET rol=? WHERE usuario=?", (rol, usuario))
        if nombre:
            c.execute("UPDATE usuarios SET nombre=? WHERE usuario=?", (nombre.strip(), usuario))
        if activo is not None:
            c.execute("UPDATE usuarios SET activo=? WHERE usuario=?", (int(bool(activo)), usuario))
            if not activo:
                c.execute("DELETE FROM sesiones WHERE usuario=?", (usuario,))


def listar_usuarios():
    with con() as c:
        return [_publico(r) for r in c.execute("SELECT * FROM usuarios ORDER BY activo DESC, nombre")]


def iniciar_sesion(usuario, clave):
    with con() as c:
        r = c.execute("SELECT * FROM usuarios WHERE usuario=?", ((usuario or "").strip().lower(),)).fetchone()
        if not r or not r["activo"] or not secrets.compare_digest(r["hash"], _hash(clave or "", r["sal"])):
            return None, None
        token = secrets.token_urlsafe(32)
        c.execute("INSERT INTO sesiones VALUES (?,?,?)", (token, r["usuario"], ahora()))
        return token, _publico(r)


def usuario_de(token):
    if not token:
        return None
    limite = (datetime.now() - timedelta(days=DIAS_SESION)).isoformat(timespec="seconds")
    with con() as c:
        r = c.execute("""SELECT u.* FROM sesiones s JOIN usuarios u ON u.usuario = s.usuario
                         WHERE s.token=? AND s.creada >= ? AND u.activo=1""", (token, limite)).fetchone()
        return _publico(r) if r else None


def cerrar_sesion(token):
    with con() as c:
        c.execute("DELETE FROM sesiones WHERE token=?", (token,))


# ----------------------------------------------------------------------------- cotizaciones
def _cot(r, completo=False):
    d = dict(r)
    datos = d.pop("datos")
    if completo:
        d["datos"] = json.loads(datos or "{}")
    return d


def guardar_cotizacion(usuario, q):
    """q trae: entrada (lo que se mandó a /api/cotizar), vehiculo (texto), resultado, confianza, margen, oferta,
    oferta_final y los datos del cliente."""
    r, e = q["resultado"], q["entrada"]
    estado = q.get("estado") or ESTADOS[0]
    if estado not in ESTADOS:
        raise ValueError("Estado no válido")
    with con() as c:
        cur = c.execute(
            f"""INSERT INTO cotizaciones(fecha, actualizada, usuario, estado, {", ".join(CAMPOS_CLIENTE)}, vehiculo, marca,
                anio, km, mercado, bajo50, alto50, margen, oferta, oferta_final, confianza, datos)
                VALUES ({",".join("?" * (4 + len(CAMPOS_CLIENTE) + 12))})""",
            (ahora(), ahora(), usuario, estado, *[(q.get(k) or "").strip() or None for k in CAMPOS_CLIENTE],
             q["vehiculo"], e["marca"], e["anio"], e.get("km"), r["mercado"], r["bajo50"], r["alto50"],
             q["margen"], q["oferta"], q.get("oferta_final") or q["oferta"], q.get("confianza"),
             json.dumps(dict(entrada=e, resultado=r), ensure_ascii=False, default=float)))
        return cur.lastrowid


def obtener_cotizacion(cid, yo):
    with con() as c:
        r = c.execute("""SELECT c.*, u.nombre AS asesor FROM cotizaciones c LEFT JOIN usuarios u ON u.usuario = c.usuario
                         WHERE c.id=?""", (cid,)).fetchone()
    if not r or (yo["rol"] != "admin" and r["usuario"] != yo["usuario"]):
        raise LookupError("Cotización no encontrada")
    return _cot(r, completo=True)


def actualizar_cotizacion(cid, yo, q):
    obtener_cotizacion(cid, yo)        # valida que exista y que pueda verla
    cambios = {k: ((q[k] or "").strip() or None) for k in CAMPOS_CLIENTE if k in q}
    if "estado" in q:
        if q["estado"] not in ESTADOS:
            raise ValueError("Estado no válido")
        cambios["estado"] = q["estado"]
    if q.get("oferta_final") is not None:
        cambios["oferta_final"] = float(q["oferta_final"])
    if not cambios:
        return
    cambios["actualizada"] = ahora()
    with con() as c:
        c.execute(f"UPDATE cotizaciones SET {', '.join(k + '=?' for k in cambios)} WHERE id=?", (*cambios.values(), cid))


def _filtro(yo, q):
    where, args = [], []
    if yo["rol"] != "admin":
        where.append("c.usuario=?"); args.append(yo["usuario"])
    elif q.get("asesor"):
        where.append("c.usuario=?"); args.append(q["asesor"])
    if q.get("estado"):
        where.append("c.estado=?"); args.append(q["estado"])
    if q.get("desde"):
        where.append("c.fecha>=?"); args.append(q["desde"])
    if q.get("texto"):
        t = f"%{q['texto'].strip()}%"
        where.append("(c.cliente LIKE ? OR c.placa LIKE ? OR c.vehiculo LIKE ? OR c.telefono LIKE ? OR CAST(c.id AS TEXT)=?)")
        args += [t, t, t, t, q["texto"].strip().lstrip("#")]
    return (" WHERE " + " AND ".join(where)) if where else "", args


def listar_cotizaciones(yo, q):
    w, args = _filtro(yo, q)
    with con() as c:
        filas = c.execute(f"""SELECT c.*, u.nombre AS asesor FROM cotizaciones c
                              LEFT JOIN usuarios u ON u.usuario = c.usuario {w} ORDER BY c.id DESC LIMIT 500""", args)
        return [_cot(r) for r in filas]


def resumen(yo, dias=30):
    desde = (datetime.now() - timedelta(days=dias - 1)).date().isoformat()
    w, args = _filtro(yo, {"desde": desde})
    with con() as c:
        filas = [dict(r) for r in c.execute(f"""SELECT c.*, u.nombre AS asesor FROM cotizaciones c
                                                LEFT JOIN usuarios u ON u.usuario = c.usuario {w}""", args)]
    total = len(filas)
    compradas = [f for f in filas if f["estado"] == "Comprada"]
    cerradas = [f for f in filas if f["estado"] in ("Comprada", "Perdida")]
    desc = [f["oferta_final"] / f["mercado"] - 1 for f in compradas if f["mercado"]]
    por_dia = {}
    for f in filas:
        por_dia[f["fecha"][:10]] = por_dia.get(f["fecha"][:10], 0) + 1
    dias_l = [(datetime.now() - timedelta(days=i)).date().isoformat() for i in range(dias - 1, -1, -1)]
    asesores, modelos = {}, {}
    for f in filas:
        a = asesores.setdefault(f["asesor"] or f["usuario"], dict(n=0, compradas=0, valor=0.0))
        a["n"] += 1
        if f["estado"] == "Comprada":
            a["compradas"] += 1
            a["valor"] += f["oferta_final"] or 0
        modelos[f["vehiculo"]] = modelos.get(f["vehiculo"], 0) + 1
    return dict(
        dias=dias, total=total, compradas=len(compradas),
        tasa=(len(compradas) / len(cerradas)) if cerradas else None,
        valor_comprado=sum(f["oferta_final"] or 0 for f in compradas),
        descuento_prom=(sum(desc) / len(desc)) if desc else None,
        por_estado={e: sum(f["estado"] == e for f in filas) for e in ESTADOS},
        por_dia=[dict(dia=d, n=por_dia.get(d, 0)) for d in dias_l],
        por_asesor=sorted(({"asesor": k, **v} for k, v in asesores.items()), key=lambda x: -x["n"]),
        top_modelos=sorted(({"vehiculo": k, "n": v} for k, v in modelos.items()), key=lambda x: -x["n"])[:8])


# ----------------------------------------------------------------------------- inventario y precio dinámico
ESTADOS_INV = ["En piso", "Reservada", "Vendida", "Liquidada"]
LINEAS = ["1001", "Autos OK"]
CAMPOS_AUTO = ["subtipo", "transmision", "combustible", "traccion", "ciudad", "provincia_placa", "vendedor_tipo",
               "climatizacion", "tapizado", "direccion", "vidrios"]
TEXTO_UNIDAD = CAMPOS_AUTO + ["vehiculo", "modelo", "version", "placa", "color", "agencia"]


def _num(v, nombre, obligatorio=True, minimo=0):
    if v in (None, ""):
        if obligatorio:
            raise ValueError(f"{nombre} es obligatorio")
        return None
    try:
        v = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{nombre} debe ser un número")
    if v < minimo:
        raise ValueError(f"{nombre} no puede ser negativo")
    return v


def _hoy():
    return datetime.now().date().isoformat()


COSTOS_MANUALES = ["costo_diario_manual", "costo_capital_manual", "costo_seguro_manual", "costo_espacio_manual",
                   "costo_lavado_manual"]       # sobrescriben el costo por día calculado con los parámetros


def _referencia(q):
    """Referencia manual de mercado de q: (valor, fuente) o (None, None). La fuente es obligatoria."""
    v = _num(q.get("mercado_manual"), "La referencia de mercado", False)
    if v is None:
        return None, None
    fuente = (q.get("fuente_mercado_manual") or "").strip()
    if v <= 0:
        raise ValueError("La referencia de mercado debe ser mayor a cero")
    if not fuente:
        raise ValueError("Escribe la fuente de la referencia de mercado (ej. comparables Patio Tuerca 03-11-2026)")
    return v, fuente


def parametros_guardados():
    with con() as c:
        r = c.execute("SELECT datos FROM parametros WHERE id=1").fetchone()
    return json.loads(r["datos"]) if r else {}


def guardar_parametros(usuario, p):
    with con() as c:
        c.execute("""INSERT INTO parametros(id, datos, actualizado, usuario) VALUES (1,?,?,?)
                     ON CONFLICT(id) DO UPDATE SET datos=excluded.datos, actualizado=excluded.actualizado,
                     usuario=excluded.usuario""", (json.dumps(p), ahora(), usuario))


def crear_unidad(usuario, q, demo=False):
    """q: datos del auto + linea, agencia, fecha_ingreso, costo_compra, reacondicionamiento, precio_publicado."""
    for k in ("marca", "familia"):
        if not (q.get(k) or "").strip():
            raise ValueError("Marca y modelo son obligatorios")
    anio = int(_num(q.get("anio"), "El año", minimo=1980))
    ingreso = (q.get("fecha_ingreso") or _hoy())[:10]
    try:
        datetime.fromisoformat(ingreso)
    except ValueError:
        raise ValueError("La fecha de ingreso no es válida")
    linea = q.get("linea") or LINEAS[0]
    if linea not in LINEAS:
        raise ValueError("Línea no válida")
    costo = _num(q.get("costo_compra"), "El costo de compra")
    pub = _num(q.get("precio_publicado"), "El precio publicado")
    if costo <= 0 or pub <= 0:
        raise ValueError("El costo de compra y el precio publicado deben ser mayores a cero")
    cot = q.get("cotizacion_id")
    pn = _num(q.get("pn_con_iva"), "El precio de nuevo", False)
    ref, fuente_ref = _referencia(q)
    cols = ["cotizacion_id", "marca", "familia", "anio", "km", "cilindraje", "pn_con_iva", "pn_origen", "linea",
            "fecha_ingreso", "costo_compra", "reacondicionamiento", "precio_publicado", "estado", "ultima_revision",
            "creado_por", "creado", "demo", "mercado_manual", "fuente_mercado_manual", "usuario_mercado_manual",
            "fecha_mercado_manual", *COSTOS_MANUALES, *TEXTO_UNIDAD]
    vals = [int(cot) if cot else None, q["marca"].strip(), q["familia"].strip(), anio,
            _num(q.get("km"), "El km", False), _num(q.get("cilindraje"), "El cilindraje", False),
            pn, (q.get("pn_origen") or ("manual" if pn else None)), linea, ingreso, costo,
            _num(q.get("reacondicionamiento"), "El reacondicionamiento", False) or 0.0, pub, "En piso", ingreso,
            usuario, ahora(), int(bool(demo)), ref, fuente_ref, usuario if ref else None, ahora() if ref else None,
            *[_num(q.get(k), k, False) for k in COSTOS_MANUALES], *[(str(q.get(k) or "").strip() or None) for k in TEXTO_UNIDAD]]
    with con() as c:
        uid = c.execute(f"INSERT INTO inventario({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", vals).lastrowid
        c.execute("""INSERT INTO precios_inventario(unidad_id, fecha, precio_anterior, precio_nuevo, precio_sugerido,
                     motivo, usuario) VALUES (?,?,?,?,?,?,?)""",
                  (uid, ahora(), None, pub, None, "Precio inicial de publicación", usuario))
        if ref:
            c.execute("""INSERT INTO referencias_mercado(unidad_id, fecha, valor, fuente, usuario, valor_modelo)
                         VALUES (?,?,?,?,?,?)""", (uid, ahora(), ref, fuente_ref, usuario, _num(q.get("_valor_modelo"), "", False)))
    return uid


def obtener_unidad(uid):
    with con() as c:
        r = c.execute("SELECT * FROM inventario WHERE id=?", (uid,)).fetchone()
    if not r:
        raise LookupError("Unidad no encontrada")
    return dict(r)


def listar_unidades(q=None):
    q = q or {}
    where, args = [], []
    for campo in ("estado", "linea", "agencia"):
        if q.get(campo):
            where.append(f"{campo}=?"); args.append(q[campo])
    if q.get("texto"):
        t = f"%{q['texto'].strip()}%"
        where.append("(vehiculo LIKE ? OR placa LIKE ? OR marca LIKE ? OR agencia LIKE ? OR CAST(id AS TEXT)=?)")
        args += [t, t, t, t, q["texto"].strip().lstrip("#")]
    with con() as c:
        return [dict(r) for r in c.execute(
            f"SELECT * FROM inventario{' WHERE ' + ' AND '.join(where) if where else ''} ORDER BY fecha_ingreso", args)]


def actualizar_unidad(uid, q, usuario=None):
    """Cambia estado y/o registra la venta; también permite corregir costos, ubicación y datos de ficha, el precio
    de nuevo, los costos propios de la unidad y la referencia manual de mercado (queda en su historial)."""
    u = obtener_unidad(uid)
    cambios = {}
    log_ref = None
    if "pn_con_iva" in q:
        pn = _num(q["pn_con_iva"], "El precio de nuevo", False)
        cambios["pn_con_iva"], cambios["pn_origen"] = pn, ("manual" if pn else None)
    for k in COSTOS_MANUALES:                       # vacío = volver al cálculo con los parámetros
        if k in q:
            cambios[k] = _num(q[k], k, False)
    if "mercado_manual" in q:
        ref, fuente = _referencia(q)
        if ref is None and u["mercado_manual"] is None:
            pass
        else:
            cambios.update(mercado_manual=ref, fuente_mercado_manual=fuente, usuario_mercado_manual=usuario if ref else None,
                           fecha_mercado_manual=ahora() if ref else None)
            log_ref = (ref, fuente if ref else "Referencia manual retirada")
    if "estado" in q:
        if q["estado"] not in ESTADOS_INV:
            raise ValueError("Estado no válido")
        cambios["estado"] = q["estado"]
    estado = cambios.get("estado", u["estado"])
    if estado in ("Vendida", "Liquidada"):
        venta = (q.get("fecha_venta") or u["fecha_venta"] or _hoy())[:10]
        if venta < u["fecha_ingreso"]:
            raise ValueError("La fecha de venta no puede ser anterior al ingreso")
        precio = q.get("precio_venta") if q.get("precio_venta") not in (None, "") else u["precio_venta"]
        cambios["fecha_venta"], cambios["precio_venta"] = venta, _num(precio, "El precio de venta")
    elif "estado" in q:
        cambios["fecha_venta"] = cambios["precio_venta"] = None
    for k in ("costo_compra", "reacondicionamiento"):
        if q.get(k) not in (None, ""):
            cambios[k] = _num(q[k], k)
    for k in ("linea", "agencia", "placa", "color"):
        if k in q:
            if k == "linea" and q[k] not in LINEAS:
                raise ValueError("Línea no válida")
            cambios[k] = (q[k] or "").strip() or None
    if not cambios:
        return
    with con() as c:
        c.execute(f"UPDATE inventario SET {', '.join(k + '=?' for k in cambios)} WHERE id=?", (*cambios.values(), uid))
        if log_ref:
            c.execute("""INSERT INTO referencias_mercado(unidad_id, fecha, valor, fuente, usuario, valor_modelo)
                         VALUES (?,?,?,?,?,?)""", (uid, ahora(), log_ref[0], log_ref[1], usuario,
                                                   _num(q.get("_valor_modelo"), "", False)))


def historial_referencias(uid):
    with con() as c:
        return [dict(r) for r in c.execute("""SELECT r.*, u.nombre AS nombre_usuario FROM referencias_mercado r
                    LEFT JOIN usuarios u ON u.usuario = r.usuario WHERE unidad_id=? ORDER BY r.id DESC""", (uid,))]


def aplicar_precio(uid, usuario, nuevo, sugerido, motivo, tolerancia):
    """Registra el cambio de precio. Si se aleja del sugerido más de la tolerancia el motivo es obligatorio."""
    u = obtener_unidad(uid)
    nuevo = _num(nuevo, "El precio nuevo")
    if nuevo <= 0:
        raise ValueError("El precio nuevo debe ser mayor a cero")
    motivo = (motivo or "").strip() or None
    if sugerido and abs(nuevo / sugerido - 1) > tolerancia and not motivo:
        raise ValueError(f"El precio se aleja más de {tolerancia * 100:.0f} % del sugerido: escribe el motivo "
                         f"(queda como excepción para el comité)")
    with con() as c:
        c.execute("""INSERT INTO precios_inventario(unidad_id, fecha, precio_anterior, precio_nuevo, precio_sugerido,
                     motivo, usuario) VALUES (?,?,?,?,?,?,?)""",
                  (uid, ahora(), u["precio_publicado"], nuevo, sugerido, motivo, usuario))
        c.execute("UPDATE inventario SET precio_publicado=?, ultima_revision=? WHERE id=?", (nuevo, _hoy(), uid))


def historial_precios(uid):
    with con() as c:
        return [dict(r) for r in c.execute("""SELECT p.*, u.nombre AS nombre_usuario FROM precios_inventario p
                    LEFT JOIN usuarios u ON u.usuario = p.usuario WHERE unidad_id=? ORDER BY p.id DESC""", (uid,))]


def cambios_precio(dias=90):
    """Cambios y revisiones de precio registrados con la regla (tienen precio sugerido), de los últimos días."""
    desde = (datetime.now() - timedelta(days=dias)).isoformat(timespec="seconds")
    with con() as c:
        return [dict(r) for r in c.execute("""SELECT p.*, i.vehiculo, i.placa, u.nombre AS nombre_usuario
                    FROM precios_inventario p JOIN inventario i ON i.id = p.unidad_id
                    LEFT JOIN usuarios u ON u.usuario = p.usuario
                    WHERE p.precio_sugerido IS NOT NULL AND p.precio_anterior IS NOT NULL AND p.fecha >= ?
                    ORDER BY p.id DESC""", (desde,))]


def excepciones_precio(tolerancia, dias=30):
    """Cambios de precio que se alejaron del sugerido en más de la tolerancia (los revisa el comité)."""
    return [r for r in cambios_precio(dias) if abs(r["precio_nuevo"] / r["precio_sugerido"] - 1) > tolerancia]


def aprobar_excepcion(pid, usuario, aprobar=True):
    """El administrador aprueba (1) o rechaza (0) el motivo de una excepción de precio."""
    with con() as c:
        r = c.execute("SELECT id FROM precios_inventario WHERE id=?", (pid,)).fetchone()
        if not r:
            raise LookupError("Cambio de precio no encontrado")
        c.execute("UPDATE precios_inventario SET aprobado=?, aprobado_por=?, aprobado_fecha=? WHERE id=?",
                  (1 if aprobar else 0, usuario, ahora(), pid))


def borrar_demo():
    with con() as c:
        ids = [r[0] for r in c.execute("SELECT id FROM inventario WHERE demo=1")]
        c.executemany("DELETE FROM precios_inventario WHERE unidad_id=?", [(i,) for i in ids])
        c.executemany("DELETE FROM referencias_mercado WHERE unidad_id=?", [(i,) for i in ids])
        c.execute("DELETE FROM inventario WHERE demo=1")
    return len(ids)
