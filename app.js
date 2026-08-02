// =========================================================================
// AGENTE DE REGLAMENTO Y AMENIDADES — UPLACE Torre 1
// CSV publicado para lectura, Apps Script (GET/POST) para escritura/admin,
// parser CSV RFC4180 char-by-char.
// =========================================================================

const CONFIG = {
  CSV_REGLAMENTO: "https://docs.google.com/spreadsheets/d/e/2PACX-1vTxhkaosS4qRt2kAyS1deAd1asEokZpN64gL26nsvBlZ-pk9pGmsurudUhxshUMxFDwqHuZkdImQso6/pub?gid=0&single=true&output=csv",
  CSV_AMENIDADES: "https://docs.google.com/spreadsheets/d/e/2PACX-1vTxhkaosS4qRt2kAyS1deAd1asEokZpN64gL26nsvBlZ-pk9pGmsurudUhxshUMxFDwqHuZkdImQso6/pub?gid=1334902608&single=true&output=csv",
  WEBAPP_URL: "https://script.google.com/macros/s/AKfycbwgDPvWpBt0axdPhJoCmqMN3xEgCwwxD71_cMHMlHdZ0Fd_mRun7Tw_yal24runQSthaA/exec"
};

let reglamentoData = [];
let amenidadesData = [];
let guardiasData = []; // se llena desde el Sheet (tab "Personal_Seguridad") para el selector del modal de identidad
let adminPin = null;

// Identidad del guardia en esta sesión de navegador (persiste entre recargas
// hasta que se use "Cambiar" o se borre el navegador). Con esto, cada
// consulta/incidente/registro queda a nombre de quien realmente lo hizo.
let guardNombre = localStorage.getItem("uplace_guard_nombre") || "";
let guardPuesto = localStorage.getItem("uplace_guard_puesto") || "";

// Historial breve del chat (para dar seguimiento: "¿y puedo invitar gente?"
// sin repetir la amenidad). Se manda al backend en cada pregunta.
let historialChat = [];

// ---------- Parser CSV RFC 4180 (char-by-char, soporta comillas y saltos de línea) ----------
function parseCSV(texto) {
  const filas = [];
  let fila = [];
  let campo = "";
  let dentroComillas = false;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    const siguiente = texto[i + 1];

    if (dentroComillas) {
      if (c === '"' && siguiente === '"') { campo += '"'; i++; }
      else if (c === '"') { dentroComillas = false; }
      else { campo += c; }
    } else {
      if (c === '"') { dentroComillas = true; }
      else if (c === ',') { fila.push(campo); campo = ""; }
      else if (c === '\r') { /* ignorar, \n lo maneja */ }
      else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ""; }
      else { campo += c; }
    }
  }
  if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }

  if (!filas.length) return [];
  const cabeceras = filas[0].map(c => c.trim());
  return filas.slice(1)
    .filter(f => f.some(v => v !== ""))
    .map(f => {
      const obj = {};
      cabeceras.forEach((cab, idx) => { obj[cab] = (f[idx] || "").trim(); });
      return obj;
    });
}

async function fetchCSV(url) {
  const res = await fetch(url + (url.includes("?") ? "&" : "?") + "_t=" + Date.now());
  const texto = await res.text();
  return parseCSV(texto);
}

async function llamarBackend(params) {
  const url = CONFIG.WEBAPP_URL + "?" + new URLSearchParams(params).toString();
  const res = await fetch(url);
  return res.json();
}

// El backend regresa errores de dos formas: { ok:false, error:"texto" } en
// las funciones normales, o { error:true, detalle:"texto" } cuando algo
// truena y lo atrapa el try/catch general de doGet (ej. falta un permiso).
// Sin esto, ese segundo caso mostraba literalmente "true" en pantalla.
function mensajeError(data, fallback) {
  if (!data) return fallback;
  if (typeof data.error === "string" && data.error) return data.error;
  if (data.detalle) return data.detalle;
  return fallback;
}

// Para acciones con carga pesada (foto de evidencia de incidentes) — POST.
async function llamarBackendPost(payload) {
  const res = await fetch(CONFIG.WEBAPP_URL, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  return res.json();
}

// ---------- Carga inicial ----------
async function cargarDatos() {
  try {
    const [reg, ame] = await Promise.all([
      fetchCSV(CONFIG.CSV_REGLAMENTO),
      fetchCSV(CONFIG.CSV_AMENIDADES)
    ]);
    reglamentoData = reg.filter(a => (a.Activo || "").trim().toLowerCase() !== "no");
    amenidadesData = ame.filter(a => (a.Activo || "").trim().toLowerCase() !== "no");
    pintarSidebar();
    poblarSelectAmenidades();
    document.getElementById("edificioSummary").textContent =
      reglamentoData.length + " artículos · " + amenidadesData.length + " amenidades";
  } catch (err) {
    console.error("Error cargando datos:", err);
    document.getElementById("edificioSummary").textContent = "Error al cargar datos";
  }
}

// Lista de guardias para el selector del modal de identidad (en vez de texto
// libre, para evitar variantes del mismo nombre en la bitácora). Si la hoja
// "Personal_Seguridad" está vacía o no existe todavía, el select solo
// muestra la opción "Otro" y cae en el input manual — no bloquea el inicio
// de sesión. El Puesto NO viene de esta hoja (se queda en su propio select
// con lista fija, tal como estaba).
async function cargarGuardias() {
  try {
    const data = await llamarBackend({ accion: "listar_guardias" });
    guardiasData = (data && data.ok && Array.isArray(data.guardias)) ? data.guardias : [];
  } catch (e) {
    guardiasData = [];
  }
  const select = document.getElementById("fIdentidadNombreSelect");
  // Quita opciones de guardias previas (deja "Selecciona…" y "Otro")
  Array.from(select.querySelectorAll("option[data-guardia]")).forEach(o => o.remove());
  guardiasData
    .slice()
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
    .forEach(g => {
      const opt = document.createElement("option");
      opt.value = g.nombre;
      opt.dataset.guardia = "1";
      opt.textContent = g.nombre;
      select.insertBefore(opt, select.querySelector('option[value="__otro__"]'));
    });
}


// Mapeo de Categoria (tal cual está en el Sheet) -> Grupo amplio para el
// submenú del sidebar. Si mañana el Comité agrega una Categoria nueva que no
// está aquí, cae en "Otros" (visible al final) en vez de tronar o desaparecer.
const GRUPOS_CATEGORIA = {
  "Fundamento y Aplicación": "Fundamento y Definiciones",
  "Definiciones Clave": "Fundamento y Definiciones",
  "Derechos y Obligaciones": "Fundamento y Definiciones",

  "Ruido y Convivencia": "Convivencia y Seguridad",
  "Mascotas": "Convivencia y Seguridad",
  "Personal de Seguridad Privada": "Convivencia y Seguridad",
  "Armas": "Convivencia y Seguridad",
  "Acceso de Visitas y Personal de Servicio": "Convivencia y Seguridad",

  "Mudanzas, Obras y Adecuaciones": "Obras y Espacios Privativos",
  "Construcción y Adecuaciones": "Obras y Espacios Privativos",
  "Estacionamientos": "Obras y Espacios Privativos",
  "Bodegas y Terrazas": "Obras y Espacios Privativos",
  "Fachadas y Persianas": "Obras y Espacios Privativos",
  "Manejo de Basura": "Obras y Espacios Privativos",

  "Régimen Disciplinario": "Gobierno, Sanciones y Conflictos",
  "Controversias entre Condóminos": "Gobierno, Sanciones y Conflictos",
  "Comité de Vigilancia": "Gobierno, Sanciones y Conflictos",
  "Administración": "Gobierno, Sanciones y Conflictos",

  "Amenidades — Base Legal": "Amenidades (Reglas de Uso)",
  "Amenidades — Acceso y Morosidad": "Amenidades (Reglas de Uso)",
  "Amenidades — Invitados": "Amenidades (Reglas de Uso)",
  "Amenidades — Entrenadores y Proveedores": "Amenidades (Reglas de Uso)",
  "Amenidades — Prohibiciones Generales": "Amenidades (Reglas de Uso)",
  "Amenidades — Sanciones y Reincidencia": "Amenidades (Reglas de Uso)"
};
const ORDEN_GRUPOS = [
  "Fundamento y Definiciones",
  "Convivencia y Seguridad",
  "Obras y Espacios Privativos",
  "Gobierno, Sanciones y Conflictos",
  "Amenidades (Reglas de Uso)",
  "Otros"
];
function obtenerGrupoDeCategoria(categoria) {
  return GRUPOS_CATEGORIA[String(categoria || "").trim()] || "Otros";
}

// Orden de categorías: en vez de alfabético, usamos el Orden mínimo de sus
// artículos — así el menú sigue la secuencia lógica original del reglamento
// (fundamento -> convivencia -> seguridad -> sanciones -> amenidades) en vez
// de mezclarse por orden alfabético de la palabra.
function ordenarClavesPorOrdenMinimo(mapaGrupos, obtenerOrden) {
  return Object.keys(mapaGrupos).sort((a, b) => {
    const minA = Math.min(...mapaGrupos[a].map(obtenerOrden));
    const minB = Math.min(...mapaGrupos[b].map(obtenerOrden));
    return minA - minB;
  });
}

// Sidebar en acordeón: cada categoría/ubicación es un <details> colapsado por
// default. Los ítems de amenidades muestran SOLO nombre + horario (apilado,
// sin recortar el nombre) — el resto de la info vive en el detalle/modal.
function pintarSidebar() {
  // ---------- Reglamento agrupado por Grupo (amplio) > Categoria (subtítulo) ----------
  const porGrupo = {}; // Grupo -> { Categoria -> [artículos] }
  reglamentoData.forEach(a => {
    const cat = a.Categoria || "General";
    const grupo = obtenerGrupoDeCategoria(cat);
    if (!porGrupo[grupo]) porGrupo[grupo] = {};
    if (!porGrupo[grupo][cat]) porGrupo[grupo][cat] = [];
    porGrupo[grupo][cat].push(a);
  });

  const contReg = document.getElementById("reglamentoList");
  contReg.innerHTML = "";
  // Respeta el orden editorial definido en ORDEN_GRUPOS; cualquier grupo
  // inesperado (no debería pasar, pero por si acaso) se agrega al final.
  const gruposPresentes = ORDEN_GRUPOS.filter(g => porGrupo[g]);
  Object.keys(porGrupo).forEach(g => { if (!gruposPresentes.includes(g)) gruposPresentes.push(g); });

  gruposPresentes.forEach(grupo => {
    const categoriasDelGrupo = porGrupo[grupo];
    const totalArticulos = Object.values(categoriasDelGrupo).reduce((sum, arr) => sum + arr.length, 0);

    const details = document.createElement("details");
    details.className = "grupo-acordeon border border-slate-200 rounded-xl overflow-hidden";
    const summary = document.createElement("summary");
    summary.className = "cursor-pointer select-none list-none flex items-center justify-between px-3 py-2 bg-slate-50 hover:bg-slate-100 text-xs font-bold text-slate-700 transition";
    summary.innerHTML = `<span class="truncate">${escapeHtml(grupo)}</span>
      <span class="shrink-0 text-[10px] font-normal text-slate-400 ml-2">${totalArticulos}</span>`;
    details.appendChild(summary);

    const cuerpo = document.createElement("div");
    cuerpo.className = "px-2 py-2 space-y-3 bg-white";

    const categoriasOrdenadas = ordenarClavesPorOrdenMinimo(categoriasDelGrupo, a => Number(a.Orden) || 0);
    categoriasOrdenadas.forEach(cat => {
      // Subtítulo de la categoría original — separador visual, ya NO es un
      // acordeón propio (para no meter un tercer nivel de clics).
      const label = document.createElement("p");
      label.className = "text-[10px] font-bold text-slate-400 uppercase tracking-wide px-1";
      label.textContent = cat;
      cuerpo.appendChild(label);

      const lista = document.createElement("div");
      lista.className = "space-y-0.5 mb-1";
      categoriasDelGrupo[cat]
        .sort((a, b) => (Number(a.Orden) || 0) - (Number(b.Orden) || 0))
        .forEach(a => {
          const btn = document.createElement("button");
          btn.className = "item-buscable w-full text-left text-xs text-slate-700 hover:bg-slate-100 rounded-lg px-3 py-2 transition";
          btn.textContent = a.Titulo;
          btn.dataset.texto = (a.Titulo + " " + a.Categoria + " " + a.Contenido).toLowerCase();
          btn.onclick = () => mostrarDetalleArticulo(a);
          lista.appendChild(btn);
        });
      cuerpo.appendChild(lista);
    });

    details.appendChild(cuerpo);
    contReg.appendChild(details);
  });

  // ---------- Amenidades: lista PLANA, una por amenidad (ya no por piso/Ubicación) ----------
  // El submenú "🏊 Amenidades" es ahora el nivel de agrupación; adentro cada
  // amenidad es su propio renglón — no hay una segunda capa por Ubicación.
  const contAme = document.getElementById("amenidadesList");
  contAme.innerHTML = "";
  amenidadesData
    .slice()
    .sort((a, b) => String(a.Nombre || "").localeCompare(String(b.Nombre || ""), "es"))
    .forEach(a => {
      const btn = document.createElement("button");
      // Nombre y horario APILADOS (no en la misma línea) para que el nombre
      // nunca se recorte y solo se agregue el dato de horario, nada más.
      btn.className = "item-buscable w-full text-left text-xs text-slate-700 hover:bg-slate-100 rounded-lg px-3 py-2 transition";
      btn.innerHTML = `<div class="font-semibold text-slate-800">${escapeHtml(a.Nombre)}</div>
        <div class="text-[10px] text-slate-400 mt-0.5">${escapeHtml(a.HorarioApertura || "")} – ${escapeHtml(a.HorarioCierre || "")}</div>`;
      btn.dataset.texto = (a.Nombre + " " + a.Ubicacion + " " + a.Restricciones).toLowerCase();
      btn.onclick = () => mostrarDetalleAmenidad(a);
      contAme.appendChild(btn);
    });

  const elCountReg = document.getElementById("countReglamento");
  if (elCountReg) elCountReg.textContent = reglamentoData.length;
  const elCountAme = document.getElementById("countAmenidades");
  if (elCountAme) elCountAme.textContent = amenidadesData.length;
}

// ---------- Buscador del sidebar (filtra en vivo Reglamento + Amenidades) ----------
function enfocarBuscador() {
  sidebar.classList.remove("-translate-x-full");
  overlay.classList.remove("hidden");
  const input = document.getElementById("buscadorSidebar");
  input.scrollIntoView({ behavior: "smooth", block: "center" });
  input.focus();
}

document.getElementById("buscadorSidebar").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll(".grupo-acordeon").forEach(details => {
    let algunaVisible = false;
    details.querySelectorAll(".item-buscable").forEach(item => {
      const coincide = !q || (item.dataset.texto || "").includes(q);
      item.classList.toggle("hidden", !coincide);
      if (coincide) algunaVisible = true;
    });
    details.classList.toggle("hidden", !algunaVisible);
    if (q) details.open = true; // auto-expandir grupos con resultados al buscar
  });
  // Submenú de nivel superior (Reglamento Interno / Amenidades): se abre si
  // tiene algo visible adentro, sin importar cuántos niveles de anidación tenga.
  document.querySelectorAll(".grupo-acordeon-nivel1").forEach(top => {
    const algunaVisible = !!top.querySelector(".item-buscable:not(.hidden)");
    if (q && algunaVisible) top.open = true;
    if (!q) top.open = false; // al borrar la búsqueda, todo vuelve a colapsado
  });
});

function mostrarDetalleArticulo(a) {
  document.getElementById("modalDetalleTitulo").textContent = a.Titulo;
  document.getElementById("modalDetalleBody").innerHTML =
    `<p class="text-[11px] font-bold text-brand-600 uppercase tracking-wide mb-2">${escapeHtml(a.Categoria || "General")}</p>
     <p class="whitespace-pre-line">${escapeHtml(a.Contenido || "")}</p>`;
  document.getElementById("modalDetalle").classList.remove("hidden");
}

function mostrarDetalleAmenidad(a) {
  const invitados = [];
  if (a.InvitadosRec1) invitados.push("1 recámara: hasta " + a.InvitadosRec1);
  if (a.InvitadosRec2) invitados.push("2 recámaras: hasta " + a.InvitadosRec2);
  if (a.InvitadosRec3) invitados.push("3 recámaras: hasta " + a.InvitadosRec3);

  document.getElementById("modalDetalleTitulo").textContent = a.Nombre;
  document.getElementById("modalDetalleBody").innerHTML = `
    <p class="mb-1"><b>Ubicación:</b> ${escapeHtml(a.Ubicacion || "-")}</p>
    <p class="mb-1"><b>Horario:</b> ${escapeHtml(a.HorarioApertura || "-")} a ${escapeHtml(a.HorarioCierre || "-")}</p>
    <p class="mb-1"><b>Días disponibles:</b> ${escapeHtml(a.DiasDisponibles || "Todos")}</p>
    <p class="mb-1"><b>Capacidad:</b> ${escapeHtml(a.CapacidadMax || "Sin límite")}</p>
    <p class="mb-1"><b>¿Requiere reservación?:</b> ${escapeHtml(a.RequiereReservacion || "No")}</p>
    ${invitados.length ? `<p class="mb-1"><b>Invitados máx. por depto:</b> ${invitados.map(escapeHtml).join(" · ")}</p>` : ""}
    <p class="mb-1"><b>Restricciones:</b> <span class="whitespace-pre-line">${escapeHtml(a.Restricciones || "Ninguna")}</span></p>
    ${a.Notas ? `<p class="mt-2 text-slate-500 whitespace-pre-line"><b>Notas:</b> ${escapeHtml(a.Notas)}</p>` : ""}
  `;
  document.getElementById("modalDetalle").classList.remove("hidden");
}

function cerrarModalDetalle() { document.getElementById("modalDetalle").classList.add("hidden"); }

// Referencia rápida de TODOS los horarios: instantánea, sin IA.
function abrirModalTodosHorarios() {
  const cont = document.getElementById("todosHorariosBody");
  const porUbicacion = {};
  amenidadesData.forEach(a => {
    const ubi = a.Ubicacion || "General";
    if (!porUbicacion[ubi]) porUbicacion[ubi] = [];
    porUbicacion[ubi].push(a);
  });

  cont.innerHTML = Object.keys(porUbicacion).sort().map(ubi => `
    <div>
      <p class="text-[11px] font-bold text-brand-600 uppercase tracking-wide mb-1">${escapeHtml(ubi)}</p>
      <div class="space-y-1.5">
        ${porUbicacion[ubi].map(a => `
          <div class="border border-slate-200 rounded-xl px-3 py-2">
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs font-bold text-slate-800 truncate">${escapeHtml(a.Nombre)}</p>
              <p class="text-[11px] font-bold text-slate-600 shrink-0">${escapeHtml(a.HorarioApertura || "-")} – ${escapeHtml(a.HorarioCierre || "-")}</p>
            </div>
            <p class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(a.DiasDisponibles || "Todos los días")}${a.RequiereReservacion ? " · Reserva: " + escapeHtml(a.RequiereReservacion) : ""}</p>
          </div>
        `).join("")}
      </div>
    </div>
  `).join("");

  document.getElementById("modalTodosHorarios").classList.remove("hidden");
}
function cerrarModalTodosHorarios() { document.getElementById("modalTodosHorarios").classList.add("hidden"); }

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// =========================================================================
// IDENTIDAD DEL GUARDIA — se pide una sola vez por sesión de navegador
// =========================================================================
function actualizarBadgeGuardia() {
  const badge = document.getElementById("badgeGuardia");
  if (guardNombre) {
    badge.classList.remove("hidden");
    badge.querySelector("#badgeGuardiaTexto").textContent = guardNombre + (guardPuesto ? " · " + guardPuesto : "");
  } else {
    badge.classList.add("hidden");
  }
}

function abrirModalIdentidad() {
  const select = document.getElementById("fIdentidadNombreSelect");
  const manual = document.getElementById("fIdentidadNombreManual");
  // Si el nombre guardado coincide con alguien de la lista, lo preselecciona;
  // si no está en la lista (guardia nuevo o "Otro"), usa el campo manual.
  const opcionExistente = guardNombre && Array.from(select.options).some(o => o.value === guardNombre && o.dataset.guardia);
  if (opcionExistente) {
    select.value = guardNombre;
    manual.classList.add("hidden");
    manual.value = "";
  } else if (guardNombre) {
    select.value = "__otro__";
    manual.classList.remove("hidden");
    manual.value = guardNombre;
  } else {
    select.value = "";
    manual.classList.add("hidden");
    manual.value = "";
  }
  document.getElementById("fIdentidadPuesto").value = guardPuesto || "Guardia de Turno";
  aplicarRestriccionPuesto(select.value === "__otro__" ? manual.value : select.value);
  document.getElementById("modalIdentidad").classList.remove("hidden");
}

// Según el prefijo del NOMBRE elegido del catálogo, se restringe qué puede
// elegir en "Tu puesto":
//   "Administración - Nombre" -> Puesto fijo en "Administración", bloqueado.
//   "Comité - Nombre"         -> Puesto fijo en "Comité de Vigilancia", bloqueado.
//   "Seguridad - Nombre"      -> Puesto libre, pero SOLO entre las opciones
//                                 operativas (Guardia/Jefe/Recepcionista/Otro);
//                                 Administración y Comité quedan ocultas.
//   Cualquier otro nombre     -> Puesto totalmente libre, todas las opciones.
function aplicarRestriccionPuesto(nombre) {
  const selectPuesto = document.getElementById("fIdentidadPuesto");
  const normalizado = String(nombre || "").trim().toLowerCase();
  const opciones = Array.from(selectPuesto.options);

  if (/^administraci[oó]n\s*-/.test(normalizado)) {
    opciones.forEach(opt => { opt.hidden = false; });
    selectPuesto.value = "Administración";
    selectPuesto.disabled = true;
  } else if (/^comit[eé]\s*-/.test(normalizado)) {
    opciones.forEach(opt => { opt.hidden = false; });
    selectPuesto.value = "Comité de Vigilancia";
    selectPuesto.disabled = true;
  } else if (/^seguridad\s*-/.test(normalizado)) {
    selectPuesto.disabled = false;
    opciones.forEach(opt => { opt.hidden = (opt.value === "Administración" || opt.value === "Comité de Vigilancia"); });
    if (selectPuesto.selectedOptions[0] && selectPuesto.selectedOptions[0].hidden) {
      selectPuesto.value = "Guardia de Turno";
    }
  } else {
    selectPuesto.disabled = false;
    opciones.forEach(opt => { opt.hidden = false; });
  }
}

// Al elegir "Otro" (no está en el catálogo Personal_Seguridad) se revela el
// campo de texto libre. El Puesto ya NO se autocompleta desde el Sheet — se
// sigue eligiendo a mano en su propio select, como estaba antes (salvo la
// restricción de Administración/Comité de arriba).
document.getElementById("fIdentidadNombreSelect").addEventListener("change", (e) => {
  const manual = document.getElementById("fIdentidadNombreManual");
  if (e.target.value === "__otro__") {
    manual.classList.remove("hidden");
    manual.value = "";
    manual.focus();
    aplicarRestriccionPuesto(""); // texto libre: sin restricción hasta que escriba algo
  } else {
    manual.classList.add("hidden");
    manual.value = "";
    aplicarRestriccionPuesto(e.target.value);
  }
});
// Si escribe manualmente un nombre con el prefijo "Administración -" o
// "Comité -" (guardia nuevo que aún no está en el catálogo), aplica la misma
// restricción mientras escribe.
document.getElementById("fIdentidadNombreManual").addEventListener("input", (e) => {
  aplicarRestriccionPuesto(e.target.value);
});
function cerrarModalIdentidad() {
  // Solo se puede cerrar si ya hay una identidad guardada (no se puede usar
  // el chat de forma anónima, para que las consultas queden a nombre de alguien).
  if (guardNombre) document.getElementById("modalIdentidad").classList.add("hidden");
}
function mostrarBienvenida() {
  pintarMensaje(
    "Hola " + guardNombre.split(" ")[0] + ", soy el Agente de Reglamento y Amenidades de UPLACE Torre 1.\n\n" +
    "Puedes preguntarme qué se puede o no se puede según el reglamento, o consultar el horario y restricciones de cualquier amenidad. También tienes estos botones en el menú:\n" +
    "🏠 Consultar / Registrar Depto — verificar morosidad, huellas e invitados, y registrar el ingreso a una amenidad.\n" +
    "🚪 Registrar salida — cuando un residente se retire.\n" +
    "🚨 Reportar incidente — si alguien incumple una norma.\n" +
    "📦 Verificar Paquetería — solo morosidad, para Lobby.\n\n" +
    "⚠️ Importante: al terminar tu turno, usa siempre \"Cerrar sesión\" (junto a tu nombre) para que el compañero que sigue entre con la suya. Si no cierras sesión, lo que él registre puede quedar a tu nombre y afectarte después.",
    "bot"
  );
}

function guardarIdentidad() {
  const select = document.getElementById("fIdentidadNombreSelect");
  const nombre = (select.value === "__otro__")
    ? document.getElementById("fIdentidadNombreManual").value.trim()
    : select.value.trim();
  const puesto = document.getElementById("fIdentidadPuesto").value.trim();
  if (!nombre) {
    document.getElementById("errorIdentidad").classList.remove("hidden");
    return;
  }
  guardNombre = nombre;
  guardPuesto = puesto || "Guardia de Turno";
  localStorage.setItem("uplace_guard_nombre", guardNombre);
  localStorage.setItem("uplace_guard_puesto", guardPuesto);
  document.getElementById("errorIdentidad").classList.add("hidden");
  actualizarBadgeGuardia();
  document.getElementById("modalIdentidad").classList.add("hidden");
  // Solo la primera vez (chat vacío) — si solo estaba corrigiendo su nombre
  // con "Cambiar", no hace falta repetir el mensaje de bienvenida.
  if (messagesEl.children.length === 0) mostrarBienvenida();
}
function cambiarGuardia() {
  abrirModalIdentidad();
}

// Cierre de sesión explícito para el cambio de turno: el guardia que se va
// presiona esto antes de entregar el equipo/tablet, así el que entra
// forzosamente tiene que registrarse con SU nombre antes de poder usar el
// chat o cualquier botón (no queda nada a nombre del guardia anterior).
function cerrarSesionGuardia() {
  if (!guardNombre) return;
  if (!confirm("¿Cerrar la sesión de " + guardNombre + "? El siguiente guardia deberá identificarse para continuar.")) return;
  guardNombre = "";
  guardPuesto = "";
  localStorage.removeItem("uplace_guard_nombre");
  localStorage.removeItem("uplace_guard_puesto");
  historialChat = []; // no arrastrar el hilo de conversación de un guardia al otro
  messagesEl.innerHTML = "";
  actualizarBadgeGuardia();
  abrirModalIdentidad();
}

// ---------- Chat ----------
const messagesEl = document.getElementById("messages");

function pintarMensaje(texto, tipo) {
  const wrap = document.createElement("div");
  wrap.className = "msg-enter flex " + (tipo === "user" ? "justify-end" : "justify-start");
  const bubble = document.createElement("div");
  bubble.className = "max-w-[85%] md:max-w-[70%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-line " +
    (tipo === "user"
      ? "bg-brand-600 text-white rounded-br-sm"
      : "bg-white border border-slate-200 text-slate-800 rounded-bl-sm shadow-sm");
  bubble.textContent = texto;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap;
}

function pintarTyping() {
  const wrap = document.createElement("div");
  wrap.className = "msg-enter flex justify-start";
  wrap.id = "typingIndicator";
  wrap.innerHTML = `<div class="bg-white border border-slate-200 rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm flex gap-1">
    <span class="typing-dot w-1.5 h-1.5 rounded-full bg-slate-400 inline-block"></span>
    <span class="typing-dot w-1.5 h-1.5 rounded-full bg-slate-400 inline-block"></span>
    <span class="typing-dot w-1.5 h-1.5 rounded-full bg-slate-400 inline-block"></span>
  </div>`;
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function quitarTyping() {
  const el = document.getElementById("typingIndicator");
  if (el) el.remove();
}

async function enviarPregunta(pregunta) {
  if (!guardNombre) { abrirModalIdentidad(); return; }
  pintarMensaje(pregunta, "user");
  historialChat.push({ rol: "user", texto: pregunta });
  pintarTyping();
  try {
    const data = await llamarBackend({
      accion: "chat",
      pregunta: pregunta,
      historial: JSON.stringify(historialChat.slice(-8)),
      guardiaNombre: guardNombre,
      guardiaPuesto: guardPuesto
    });
    quitarTyping();
    if (data.error) {
      pintarMensaje("No pude conectarme con el reglamento en este momento. Por favor contacta al Jefe de Turno o al Comité directamente.", "bot");
    } else {
      pintarMensaje(data.respuesta_ia, "bot");
      historialChat.push({ rol: "assistant", texto: data.respuesta_ia });
    }
  } catch (err) {
    quitarTyping();
    pintarMensaje("Error de conexión. Intenta de nuevo en unos segundos.", "bot");
    console.error(err);
  }
}

document.getElementById("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = document.getElementById("chatInput");
  const texto = input.value.trim();
  if (!texto) return;
  input.value = "";
  enviarPregunta(texto);
});

// ---------- Sidebar móvil ----------
const sidebar = document.getElementById("sidebar");
const overlay = document.getElementById("sidebarOverlay");
document.getElementById("openSidebarBtn").addEventListener("click", () => {
  sidebar.classList.remove("-translate-x-full");
  overlay.classList.remove("hidden");
  sidebarMobileAbierto = true;
  aplicarVisibilidadFab(); // oculta el flotante mientras el menú está abierto (solo en móvil)
});
function cerrarSidebar() {
  sidebar.classList.add("-translate-x-full");
  overlay.classList.add("hidden");
  sidebarMobileAbierto = false;
  aplicarVisibilidadFab(); // vuelve a mostrar el flotante si sigue habiendo ocupación activa
}
document.getElementById("closeSidebarBtn").addEventListener("click", cerrarSidebar);
overlay.addEventListener("click", cerrarSidebar);

// =========================================================================
// CONSULTAR DEPTO — morosidad (2 strikes) + límite de invitados por amenidad
// =========================================================================
function poblarSelectAmenidades() {
  const select = document.getElementById("fConsultaAmenidad");
  if (!select) return;
  select.innerHTML = `<option value="">Sin amenidad (solo verificar depto)</option>` +
    amenidadesData.map(a => `<option value="${escapeHtml(a.AmenidadID)}">${escapeHtml(a.Nombre)}</option>`).join("");
}

function abrirModalConsultarDepto() {
  document.getElementById("fConsultaDepto").value = "";
  document.getElementById("fConsultaNombreResidente").value = "";
  document.getElementById("fConsultaResidentes").value = "";
  document.getElementById("fConsultaInvitados").value = "";
  document.getElementById("fConsultaNotas").value = "";
  document.getElementById("resultadoConsultaDepto").innerHTML = "";
  document.getElementById("modalConsultarDepto").classList.remove("hidden");
  setTimeout(() => document.getElementById("fConsultaDepto").focus(), 100);
}
function cerrarModalConsultarDepto() { document.getElementById("modalConsultarDepto").classList.add("hidden"); }

let ultimaConsultaDepto = null; // guarda el resultado para poder "registrar ingreso" después

async function ejecutarConsultaDepto() {
  const depto = document.getElementById("fConsultaDepto").value.trim();
  const amenidadId = document.getElementById("fConsultaAmenidad").value;
  const nombreResidentePresenta = document.getElementById("fConsultaNombreResidente").value.trim();
  const numResidentes = document.getElementById("fConsultaResidentes").value.trim();
  const numInvitados = document.getElementById("fConsultaInvitados").value.trim();
  const notas = document.getElementById("fConsultaNotas").value.trim();
  const resultado = document.getElementById("resultadoConsultaDepto");

  if (!depto) { resultado.innerHTML = `<p class="text-red-600 text-xs">Escribe el número de depto.</p>`; return; }
  resultado.innerHTML = `<p class="text-slate-500 text-xs">Consultando…</p>`;

  const data = await llamarBackend({
    accion: "verificar_acceso",
    depto: depto,
    amenidadId: amenidadId,
    numResidentes: numResidentes,
    numInvitados: numInvitados,
    guardiaNombre: guardNombre,
    guardiaPuesto: guardPuesto
  });

  if (!data.ok) {
    resultado.innerHTML = `<p class="text-red-600 text-xs">${escapeHtml(data.error || "Error al consultar.")}</p>`;
    return;
  }
  ultimaConsultaDepto = { depto, amenidadId, nombreResidentePresenta, numResidentes, numInvitados, notas, data };

  const m = data.moroso;
  // Política sin tolerancia: un moroso se bloquea SIEMPRE (ya no existe el
  // "primer aviso, se le deja pasar" — se dejó el color ámbar solo por si
  // llegara a verse un depto marcado "Moroso" sin acción resuelta todavía).
  let colorMoroso = "bg-emerald-50 border-emerald-200 text-emerald-800";
  let tituloMoroso = "✅ Al corriente";
  if (m.accion === "bloqueado") { colorMoroso = "bg-red-50 border-red-300 text-red-800"; tituloMoroso = "🚫 MOROSO — NO SE PERMITE EL ACCESO"; }
  else if (m.accion === "excepcion_petzone") { colorMoroso = "bg-amber-50 border-amber-300 text-amber-800"; tituloMoroso = "⚠️ MOROSO — excepción Pet Zone, SÍ se permite"; }
  else if (m.estatus && m.estatus.toLowerCase() === "moroso") { colorMoroso = "bg-amber-50 border-amber-300 text-amber-800"; tituloMoroso = "⚠️ Moroso"; }

  let html = `
    <div class="border rounded-xl p-3 ${colorMoroso}">
      <p class="text-xs font-bold">${tituloMoroso}</p>
      <p class="text-xs mt-1">${escapeHtml(m.mensaje)}</p>
      ${m.tieneConvenio && m.tieneConvenio.toLowerCase() === "si" ? `<p class="text-xs mt-1"><b>Tiene convenio de pago:</b> ${escapeHtml(m.detalleConvenio || "Sin detalle registrado")}</p>` : ""}
    </div>
    <div class="border border-slate-200 rounded-xl p-3 mt-2">
      <p class="text-xs text-slate-700"><b>Depto ${escapeHtml(depto)}</b>${data.recamaras ? " · " + data.recamaras + " recámara(s)" : " · recámaras no registradas"}</p>
      ${data.nombreResidente ? `<p class="text-[11px] text-slate-500 mt-0.5">Titular registrado: <b>${escapeHtml(data.nombreResidente)}</b> — cotéjalo contra la identificación.</p>` : ""}
      ${!data.deptoEncontrado ? `<p class="text-[11px] text-amber-600 mt-1">Este depto no está en el padrón — verifica manualmente los datos.</p>` : ""}
    </div>
  `;

  // ---------- Residentes del depto vs huellas registradas (contra capacidad DISPONIBLE) ----------
  const r = data.residentes;
  if (r) {
    let colorResidentes = "border-slate-200";
    let residentesTxt;
    if (r.huellasRegistradas === null) {
      residentesTxt = `<p class="text-xs text-slate-600 mt-1">Total: <b>${r.totalResidentesVisita}</b> residente(s) del depto (quien registra${r.numResidentesAdicionales ? " + " + r.numResidentesAdicionales + " más" : ""}). Sin huellas registradas para este depto — verifica manualmente.</p>`;
    } else if (r.permitido) {
      colorResidentes = "border-emerald-200 bg-emerald-50";
      residentesTxt = `<p class="text-xs font-bold text-emerald-700 mt-1">✅ Puede pasar: caben ${r.totalResidentesVisita} de ${r.disponibles} disponible(s) ahora.</p>
        <p class="text-[11px] text-slate-500 mt-0.5">Huellas registradas: ${r.huellasRegistradas}${r.activosAhora ? " · ya hay " + r.activosAhora + " residente(s) activo(s) en esta amenidad" : ""}.</p>`;
    } else {
      colorResidentes = "border-red-200 bg-red-50";
      residentesTxt = r.activosAhora > 0
        ? `<p class="text-xs font-bold text-red-700 mt-1">🚫 Ahorita solo caben ${r.disponibles} de los ${r.totalResidentesVisita} residentes declarados — ya hay ${r.activosAhora} activo(s) en esta amenidad (huellas registradas: ${r.huellasRegistradas}).</p>`
        : `<p class="text-xs font-bold text-red-700 mt-1">🚫 Supera las huellas disponibles: ${r.totalResidentesVisita} residentes declarados, pero el depto solo tiene ${r.huellasRegistradas} huella(s) registrada(s).</p>`;
    }
    html += `
      <div class="border ${colorResidentes} rounded-xl p-3 mt-2">
        <p class="text-xs font-bold text-slate-800">👥 Residentes del depto que se presentan</p>
        ${residentesTxt}
      </div>
    `;
  }

  if (data.amenidad) {
    const am = data.amenidad;
    const noAceptaInvitados = am.limiteInvitados === 0; // amenidad configurada con límite 0 (ej. Gimnasio)
    let permitidoTxt = "";
    if (noAceptaInvitados) {
      // Antes decía "Máximo 0 invitado(s)", que se lee raro — esta amenidad
      // directamente no admite invitados, sin importar cuántos se declaren.
      permitidoTxt = (am.invitadosSolicitados && am.invitadosSolicitados > 0)
        ? `<p class="text-xs mt-1 font-bold text-red-700">🚫 Esta amenidad no acepta invitados — solo residentes del depto.</p>`
        : `<p class="text-xs text-slate-600 mt-1">Esta amenidad no acepta invitados.</p>`;
    } else if (am.invitadosSolicitados === null || am.invitadosSolicitados === 0) {
      // Bug corregido: con 0 invitados no hay nada que "permitir" — no se
      // muestra un check de "sí puede pasar con sus 0 invitados".
      permitidoTxt = am.limiteInvitados === null
        ? `<p class="text-xs text-slate-600 mt-1">No ingresa con invitados.</p>`
        : `<p class="text-xs text-slate-600 mt-1">No ingresa con invitados. (Máximo ${am.limiteInvitados} invitado(s) para este depto si ingresara con alguno).</p>`;
    } else if (am.limiteInvitados === null) {
      permitidoTxt = `<p class="text-xs text-slate-600 mt-1">Sin límite de invitados registrado por recámara para esta amenidad — revisa las restricciones abajo.</p>`;
    } else {
      const ok = am.permitido;
      if (ok) {
        permitidoTxt = `<p class="text-xs mt-1 font-bold text-emerald-700">✅ Puede pasar con sus ${am.invitadosSolicitados} invitado(s).</p>
          <p class="text-[11px] text-slate-500 mt-0.5">Disponibles ahora: ${am.invitadosDisponibles} de ${am.limiteInvitados}${am.invitadosActivosAhora ? " · ya hay " + am.invitadosActivosAhora + " invitado(s) activo(s) en esta amenidad" : ""}.</p>`;
      } else {
        permitidoTxt = am.invitadosActivosAhora > 0
          ? `<p class="text-xs mt-1 font-bold text-red-700">🚫 Ahorita solo caben ${am.invitadosDisponibles} de los ${am.invitadosSolicitados} invitados declarados — ya hay ${am.invitadosActivosAhora} activo(s) (límite ${am.limiteInvitados}).</p>`
          : `<p class="text-xs mt-1 font-bold text-red-700">🚫 Excede el límite de invitados (máximo ${am.limiteInvitados}).</p>`;
      }
    }

    // ---------- Capacidad total del área (todos los deptos combinados) ----------
    // La ocupación actual se muestra SIEMPRE (pase o no pase la verificación),
    // no solo cuando sí cabe — para que el guardia tenga el dato de contexto
    // en cualquier caso. El mensaje de bloqueo distingue tres situaciones:
    //   1) Bajando el número de invitados SÍ cabría (le decimos la cifra
    //      exacta que sí cabe, para que el guardia se lo diga al condómino).
    //   2) Ni siquiera 0 invitados cabría, pero es porque hay OTRA gente en
    //      el área ahora mismo.
    //   3) Ni siquiera 0 invitados cabría, y el área está vacía — el grupo
    //      de residentes por sí solo ya es más grande que el área.
    let capacidadTxt = "";
    if (am.capacidadTotal !== null) {
      capacidadTxt = `<p class="text-[11px] text-slate-500 mt-1">Cupo del área: ${am.ocupacionTotalAhora} de ${am.capacidadTotal} lo están ocupando ahora (contando a todos los registros, no solo este).</p>`;
      if (!am.permitidoCapacidad) {
        const maxInv = am.invitadosMaximoPorCapacidad;
        let motivo;
        if (maxInv !== null && maxInv < (am.invitadosSolicitados || 0)) {
          motivo = maxInv > 0
            ? `Con los ${r.totalResidentesVisita} residentes apuntados en este grupo, el área solo tiene espacio para <b>${maxInv} invitado(s)</b> más ahora (solicitan ${am.invitadosSolicitados}). Dile al condómino que puede ingresar hasta ${maxInv} invitado(s), no los ${am.invitadosSolicitados} que quiere ingresar.`
            : `Con los ${r.totalResidentesVisita} residentes apuntados en este grupo, ya no queda espacio para ningún invitado en el área ahora.`;
        } else {
          motivo = am.ocupacionTotalAhora > 0
            ? `Ya hay ${am.ocupacionTotalAhora} persona(s) en el área ahora; con lo que queda disponible no alcanza para los ${r.totalResidentesVisita} residentes apuntados en este grupo. Dile al condómino que puede ingresar hasta ${am.capacidadDisponible} residente(s), no los ${r.totalResidentesVisita} que quiere ingresar.`
            : `El grupo solicitado (${am.totalPersonasSolicitadas} persona(s)) ya supera por sí solo el máximo del área (${am.capacidadTotal}), sin contar invitados. Dile al condómino que puede ingresar hasta ${am.capacidadDisponible} persona(s) en el área.`;
        }
        capacidadTxt += `<p class="text-xs mt-1 font-bold text-red-700">🚫 No caben en el área: ${motivo}</p>`;
      }
    }

    // El botón de registrar ingreso se bloquea (gris, no clicable) si el
    // depto está moroso-bloqueado, si los residentes exceden las huellas
    // registradas, si los invitados exceden el límite de la amenidad, o si
    // no cabe en la capacidad total del área (todos los deptos combinados)
    // — en cualquiera de esos casos no debe poder registrarse el ingreso.
    const bloqueadoPorMoroso = m.accion === "bloqueado";
    const bloqueadoPorResidentes = r && r.permitido === false;
    const bloqueadoPorInvitados = am.permitido === false;
    const bloqueadoPorCapacidad = am.permitidoCapacidad === false;
    const bloqueado = bloqueadoPorMoroso || bloqueadoPorResidentes || bloqueadoPorInvitados || bloqueadoPorCapacidad;

    let motivoBloqueo = "";
    if (bloqueadoPorMoroso) motivoBloqueo = "El depto está moroso y bloqueado.";
    else if (bloqueadoPorResidentes) motivoBloqueo = "Los residentes superan las huellas registradas.";
    else if (bloqueadoPorInvitados) motivoBloqueo = "Los invitados exceden el límite permitido.";
    else if (bloqueadoPorCapacidad) motivoBloqueo = "No hay cupo en el área — ya está en su capacidad máxima.";

    html += `
      <div class="border border-slate-200 rounded-xl p-3 mt-2">
        <p class="text-xs font-bold text-slate-800">${escapeHtml(am.nombre)}</p>
        <p class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(am.horario)} · ${escapeHtml(am.dias)}</p>
        ${permitidoTxt}
        ${capacidadTxt}
        <p class="text-[11px] text-slate-500 mt-1 whitespace-pre-line">${escapeHtml(am.restricciones)}</p>
        ${bloqueado
          ? `<p class="text-[11px] text-red-600 font-bold mt-2">🚫 No se puede registrar el ingreso: ${escapeHtml(motivoBloqueo)}</p>
             <button disabled class="w-full mt-1 bg-slate-300 text-slate-500 rounded-lg py-2 text-xs font-bold cursor-not-allowed">Registrar ingreso a esta amenidad</button>`
          : `<button id="btnRegistrarIngreso" onclick="registrarIngresoAmenidad()" class="w-full mt-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg py-2 text-xs font-bold transition">✅ Registrar ingreso a esta amenidad</button>`
        }
      </div>
    `;
  }

  resultado.innerHTML = html;
}

async function registrarIngresoAmenidad() {
  if (!ultimaConsultaDepto || !ultimaConsultaDepto.data.amenidad) return;
  const boton = document.getElementById("btnRegistrarIngreso");
  // Bloqueo de un solo clic: en cuanto se presiona, se deshabilita y se pone
  // gris — así no se puede volver a registrar el mismo ingreso por accidente
  // con un doble clic.
  if (boton) {
    boton.disabled = true;
    boton.textContent = "Registrado ✓";
    boton.className = "w-full mt-2 bg-slate-300 text-slate-500 rounded-lg py-2 text-xs font-bold cursor-not-allowed";
  }

  const { depto, nombreResidentePresenta, numResidentes, numInvitados, notas, data } = ultimaConsultaDepto;
  const resp = await llamarBackend({
    accion: "registrar_reservacion",
    depto: depto,
    amenidad: data.amenidad.nombre,
    nombreResidentePresenta: nombreResidentePresenta || "",
    numResidentes: numResidentes || "0",
    numInvitados: numInvitados || "0",
    notas: notas || "",
    guardiaNombre: guardNombre,
    guardiaPuesto: guardPuesto
  });

  if (resp && resp.columnasFaltantes && resp.columnasFaltantes.length) {
    document.getElementById("resultadoConsultaDepto").insertAdjacentHTML("beforeend",
      `<p class="text-amber-600 text-[11px] mt-2">⚠️ Faltan columnas en Bitacora_Reservaciones, no se guardaron: ${escapeHtml(resp.columnasFaltantes.join(", "))}.</p>`);
  }
  document.getElementById("resultadoConsultaDepto").insertAdjacentHTML("beforeend",
    `<p class="text-emerald-700 text-xs font-bold mt-2">✅ Ingreso registrado en la bitácora.</p>`);
  alert("✅ Registro guardado correctamente.");
  actualizarFabSalida();
}

// =========================================================================
// BOTÓN FLOTANTE — siempre visible mientras haya alguien activo sin salida
// =========================================================================
let sidebarMobileAbierto = false; // lo actualiza el toggle del sidebar, más abajo

async function actualizarFabSalida() {
  try {
    const data = await llamarBackend({ accion: "contar_activos" });
    aplicarVisibilidadFab(data);
  } catch (e) {
    // Silencioso: si falla la consulta del badge no debe interrumpir nada más.
  }
}

// Separado de la llamada al backend para poder re-aplicar la visibilidad
// solo por cambio de estado del sidebar, sin tener que volver a consultar.
let ultimoConteoActivos = null;
function aplicarVisibilidadFab(data) {
  if (data) ultimoConteoActivos = data;
  const info = ultimoConteoActivos;
  const fab = document.getElementById("fabRegistrarSalida");
  const badge = document.getElementById("fabBadge");
  const menuBadge = document.getElementById("menuBadgeSalida");

  const hayActivos = info && info.ok && info.totalPersonas > 0;
  const textoBadge = hayActivos ? (info.totalPersonas + (info.totalDeptos > 1 ? " · " + info.totalDeptos + " deptos" : "")) : "";

  // El botón del menú lateral SIEMPRE puede mostrar su badge (no depende de
  // si el sidebar está abierto — de hecho solo se ve cuando SÍ está abierto).
  if (hayActivos) {
    menuBadge.textContent = textoBadge;
    menuBadge.classList.remove("hidden");
  } else {
    menuBadge.classList.add("hidden");
  }

  // El flotante: en móvil se oculta mientras el sidebar está abierto (para
  // no tapar el menú, que ya trae su propio botón con el mismo dato). En
  // desktop el sidebar no se superpone al contenido, así que el flotante
  // siempre sigue la regla normal de ocupación, sin importar el sidebar.
  const esMobile = window.matchMedia("(max-width: 767px)").matches;
  const ocultarPorSidebar = esMobile && sidebarMobileAbierto;

  if (hayActivos && !ocultarPorSidebar) {
    badge.textContent = textoBadge;
    fab.classList.remove("hidden");
    requestAnimationFrame(() => fab.classList.remove("translate-y-4", "opacity-0"));
  } else {
    fab.classList.add("translate-y-4", "opacity-0");
    setTimeout(() => { if (fab.classList.contains("opacity-0")) fab.classList.add("hidden"); }, 300);
  }
}

// =========================================================================
// REGISTRAR SALIDA — ocupación activa por depto+amenidad, salidas parciales
// =========================================================================
function abrirModalRegistrarSalida() {
  document.getElementById("modalRegistrarSalida").classList.remove("hidden");
  cargarRegistrosActivos();
}
function cerrarModalRegistrarSalida() { document.getElementById("modalRegistrarSalida").classList.add("hidden"); }

// Genera <option>1</option>..<option>n</option> — el máximo activo queda
// preseleccionado por default (salida completa), pero el guardia puede
// elegir un número menor para una salida parcial. Nunca se puede escribir
// un número inválido porque ya no es un campo de texto libre.
function opcionesNumericas(n) {
  let html = "";
  for (let v = 1; v <= n; v++) {
    html += `<option value="${v}"${v === n ? " selected" : ""}>${v}</option>`;
  }
  return html;
}

async function cargarRegistrosActivos() {
  const cont = document.getElementById("listaRegistrosActivos");
  cont.innerHTML = `<p class="text-slate-500 text-xs">Cargando ocupación activa…</p>`;
  const data = await llamarBackend({ accion: "listar_registros_activos" });
  if (!data || !data.ok) {
    cont.innerHTML = `<p class="text-red-600 text-xs">${escapeHtml(mensajeError(data, "No se pudieron cargar los registros."))}</p>`;
    return;
  }
  if (!data.grupos.length) {
    cont.innerHTML = `<p class="text-slate-500 text-xs">No hay nadie activo ahora del día de hoy — todos tienen salida registrada.</p>`;
    return;
  }
  // Menú de dos niveles: primero la amenidad (colapsada), al abrirla aparece
  // el listado de deptos activos en ESA amenidad — así no es un listado
  // plano gigante. Vienen ya ordenados por amenidad y, dentro de cada una,
  // por llegada más antigua primero (el más reciente queda hasta abajo).
  const porAmenidad = {};
  data.grupos.forEach(g => {
    if (!porAmenidad[g.amenidad]) porAmenidad[g.amenidad] = [];
    porAmenidad[g.amenidad].push(g);
  });

  let html = "";
  let idxGlobal = 0;
  Object.keys(porAmenidad).forEach((amenidad, ai) => {
    const items = porAmenidad[amenidad];
    const totalPersonas = items.reduce((s, g) => s + g.activosResidentes + g.activosInvitados, 0);
    html += `
      <details class="border border-slate-200 rounded-xl overflow-hidden">
        <summary class="cursor-pointer select-none list-none flex items-center justify-between px-3 py-2.5 bg-indigo-50 hover:bg-indigo-100 text-xs font-bold text-indigo-900 transition">
          <span>${escapeHtml(amenidad)}</span>
          <span class="text-[10px] font-normal text-indigo-600">${items.length} depto(s) · ${totalPersonas} activo(s)</span>
        </summary>
        <div class="p-2 space-y-2 bg-white">
    `;
    items.forEach(g => {
      const i = idxGlobal++;
      html += `
        <div class="border border-slate-200 rounded-xl p-3">
          <p class="text-xs font-bold text-slate-800">Depto ${escapeHtml(g.depto)}${g.nombreResidentePresenta ? " - " + escapeHtml(g.nombreResidentePresenta) : ""}</p>
          <p class="text-[11px] text-slate-500 mt-0.5">
            Activos ahora: <b>${g.activosResidentes} residente(s)</b>, <b>${g.activosInvitados} invitado(s)</b>
            ${g.primeraLlegadaTexto ? " · adentro desde " + escapeHtml(g.primeraLlegadaTexto) : ""}
          </p>
          <div class="grid grid-cols-2 gap-2 mt-2">
            <div>
              <label class="block text-[10px] font-bold text-slate-500 mb-0.5">Residentes que salen</label>
              ${g.activosResidentes > 0
                ? `<select id="salidaRes-${i}" class="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                     ${opcionesNumericas(g.activosResidentes)}
                   </select>`
                : `<select id="salidaRes-${i}" disabled class="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm bg-slate-100 text-slate-400"><option value="0">— (0 activos)</option></select>`}
            </div>
            <div>
              <label class="block text-[10px] font-bold text-slate-500 mb-0.5">Invitados que salen</label>
              ${g.activosInvitados > 0
                ? `<select id="salidaInv-${i}" class="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
                     ${opcionesNumericas(g.activosInvitados)}
                   </select>`
                : `<select id="salidaInv-${i}" disabled class="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm bg-slate-100 text-slate-400"><option value="0">— (0 activos)</option></select>`}
            </div>
          </div>
          <button onclick="registrarSalidaClick('${escapeHtml(g.depto)}', '${escapeHtml(g.amenidad)}', ${i})" class="w-full mt-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-3 py-2 text-[11px] font-bold transition">Registrar salida</button>
        </div>
      `;
    });
    html += `</div></details>`;
  });
  cont.innerHTML = html;
}

async function registrarSalidaClick(depto, amenidad, i) {
  const numResidentesSalen = Math.max(0, Math.floor(Number(document.getElementById("salidaRes-" + i).value) || 0));
  const numInvitadosSalen = Math.max(0, Math.floor(Number(document.getElementById("salidaInv-" + i).value) || 0));
  if (numResidentesSalen === 0 && numInvitadosSalen === 0) {
    alert("Indica cuántos residentes o invitados están saliendo.");
    return;
  }
  const confirmado = confirm(
    "Vas a registrar la salida de " + numResidentesSalen + " residente(s) y " + numInvitadosSalen +
    " invitado(s) del depto " + depto + " en " + amenidad + ". ¿Confirmar?"
  );
  if (!confirmado) return;

  const data = await llamarBackend({
    accion: "registrar_salida",
    depto: depto,
    amenidad: amenidad,
    numResidentesSalen: numResidentesSalen,
    numInvitadosSalen: numInvitadosSalen
  });
  if (!data || !data.ok) {
    alert("No se pudo registrar la salida: " + (mensajeError(data, "error desconocido")));
    return;
  }
  if (data.advertencia) alert("⚠️ " + data.advertencia);
  alert("✅ Salida registrada correctamente (" + data.fechaSalida + "): " +
    data.residentesRegistrados + " residente(s) y " + data.invitadosRegistrados + " invitado(s).");
  cargarRegistrosActivos(); // refresca: si ya no queda nadie activo, el card desaparece solo
  actualizarFabSalida();
}

// =========================================================================
// VERIFICAR PAQUETERÍA — solo morosidad, para Lobby/Recepción
// =========================================================================
function abrirModalVerificarPaqueteria() {
  document.getElementById("fPaqueteriaDepto").value = "";
  document.getElementById("resultadoVerificarPaqueteria").innerHTML = "";
  document.getElementById("modalVerificarPaqueteria").classList.remove("hidden");
  setTimeout(() => document.getElementById("fPaqueteriaDepto").focus(), 100);
}
function cerrarModalVerificarPaqueteria() { document.getElementById("modalVerificarPaqueteria").classList.add("hidden"); }

async function ejecutarVerificarPaqueteria() {
  const depto = document.getElementById("fPaqueteriaDepto").value.trim();
  const resultado = document.getElementById("resultadoVerificarPaqueteria");
  if (!depto) { resultado.innerHTML = `<p class="text-red-600 text-xs">Escribe el número de depto.</p>`; return; }
  resultado.innerHTML = `<p class="text-slate-500 text-xs">Consultando…</p>`;

  const data = await llamarBackend({
    accion: "verificar_moroso_simple",
    depto: depto,
    guardiaNombre: guardNombre,
    guardiaPuesto: guardPuesto
  });
  if (!data || !data.ok) {
    resultado.innerHTML = `<p class="text-red-600 text-xs">${escapeHtml(mensajeError(data, "Error al consultar."))}</p>`;
    return;
  }
  const color = data.esMoroso ? "bg-red-50 border-red-300 text-red-800" : "bg-emerald-50 border-emerald-200 text-emerald-800";
  const titulo = data.esMoroso ? "🚫 MOROSO — no entregar paquetería sin autorización" : "✅ Al corriente";
  resultado.innerHTML = `
    <div class="border rounded-xl p-3 mt-1 ${color}">
      <p class="text-xs font-bold">${titulo}</p>
      <p class="text-xs mt-1">Depto ${escapeHtml(depto)}${!data.deptoEncontrado ? " (no está en el padrón de morosos — se asume al corriente)" : ""}</p>
      ${data.tieneConvenio && data.tieneConvenio.toLowerCase() === "si" ? `<p class="text-xs mt-1"><b>Tiene convenio de pago:</b> ${escapeHtml(data.detalleConvenio || "Sin detalle registrado")}</p>` : ""}
    </div>
  `;
}

// =========================================================================
// REGISTRAR INCIDENTE — con foto de evidencia opcional
// =========================================================================
let incidenteFotoBase64 = null;
let incidenteFotoMime = null;
let incidenteFotoNombre = null;

function abrirModalIncidente() {
  document.getElementById("fIncidenteDepto").value = "";
  document.getElementById("fIncidenteDescripcion").value = "";
  document.getElementById("fIncidenteRegla").value = "";
  document.getElementById("fIncidenteFoto").value = "";
  document.getElementById("previewIncidenteFoto").classList.add("hidden");
  document.getElementById("resultadoIncidente").innerHTML = "";
  incidenteFotoBase64 = null;
  document.getElementById("modalIncidente").classList.remove("hidden");
}
function cerrarModalIncidente() { document.getElementById("modalIncidente").classList.add("hidden"); }

document.getElementById("fIncidenteFoto").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  incidenteFotoMime = file.type;
  incidenteFotoNombre = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    incidenteFotoBase64 = reader.result.split(",")[1];
    const preview = document.getElementById("previewIncidenteFoto");
    preview.src = reader.result;
    preview.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
});

async function enviarIncidente() {
  const depto = document.getElementById("fIncidenteDepto").value.trim();
  const descripcion = document.getElementById("fIncidenteDescripcion").value.trim();
  const reglaViolada = document.getElementById("fIncidenteRegla").value.trim();
  const resultado = document.getElementById("resultadoIncidente");

  if (!depto || !descripcion) {
    resultado.innerHTML = `<p class="text-red-600 text-xs">Depto y descripción son obligatorios.</p>`;
    return;
  }
  resultado.innerHTML = `<p class="text-slate-500 text-xs">Guardando incidente…</p>`;

  const payload = {
    accion: "registrar_incidente",
    depto: depto,
    descripcion: descripcion,
    reglaViolada: reglaViolada,
    guardiaNombre: guardNombre,
    guardiaPuesto: guardPuesto
  };
  if (incidenteFotoBase64) {
    payload.fotoBase64 = incidenteFotoBase64;
    payload.fotoMime = incidenteFotoMime;
    payload.fotoNombre = incidenteFotoNombre;
  }

  const data = await llamarBackendPost(payload);
  if (data.ok) {
    resultado.innerHTML = `<p class="text-emerald-700 text-xs font-bold">✅ Incidente ${escapeHtml(data.incidenteId)} registrado correctamente.</p>`;
  } else {
    resultado.innerHTML = `<p class="text-red-600 text-xs">${escapeHtml(data.error || "No se pudo registrar el incidente.")}</p>`;
  }
}

// ---------- Panel Admin ----------
function abrirPanelAdmin() {
  document.getElementById("modalAdmin").classList.remove("hidden");
  if (adminPin) {
    cargarPanelAdmin();
  } else {
    pintarLoginAdmin();
  }
}
function cerrarModalAdmin() { document.getElementById("modalAdmin").classList.add("hidden"); }

function pintarLoginAdmin() {
  document.getElementById("adminBody").innerHTML = `
    <p class="text-sm text-slate-600 mb-3">Ingresa el PIN del Comité para editar el reglamento y las amenidades.</p>
    <input id="pinInput" type="password" inputmode="numeric" placeholder="PIN"
      class="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
    <button id="pinSubmit" class="w-full bg-slate-900 hover:bg-slate-800 text-white rounded-xl py-3 text-sm font-bold transition">Entrar</button>
    <p id="pinError" class="text-red-600 text-xs mt-2 hidden">PIN incorrecto.</p>
  `;
  document.getElementById("pinSubmit").addEventListener("click", async () => {
    const pin = document.getElementById("pinInput").value.trim();
    const data = await llamarBackend({ accion: "validar_pin", pin: pin });
    if (data.ok) {
      adminPin = pin;
      cargarPanelAdmin();
    } else {
      document.getElementById("pinError").classList.remove("hidden");
    }
  });
}

const TABS_ADMIN = [
  { id: "Reg", label: "Reglamento" },
  { id: "Ame", label: "Amenidades" },
  { id: "Mor", label: "Morosos" },
  { id: "Inc", label: "Incidentes" }
];

async function cargarPanelAdmin() {
  document.getElementById("adminBody").innerHTML = `<p class="text-sm text-slate-500">Cargando…</p>`;
  const [regData, ameData, morData, incData, estadoTrigger] = await Promise.all([
    llamarBackend({ accion: "listar_reglamento", pin: adminPin }),
    llamarBackend({ accion: "listar_amenidades", pin: adminPin }),
    llamarBackend({ accion: "listar_morosos", pin: adminPin }),
    llamarBackend({ accion: "listar_incidentes", pin: adminPin }),
    llamarBackend({ accion: "estado_trigger_mensual", pin: adminPin })
  ]);

  const body = document.getElementById("adminBody");
  body.innerHTML = `
    <div class="border border-sky-200 bg-sky-50 rounded-xl p-3 mb-3">
      <p class="text-xs font-bold text-sky-800">📦 Archivado mensual</p>
      <p class="text-[11px] text-sky-700 mt-1">Bitacora_Reservaciones y Consultas_Seguridad se vacían solas cada día 1 del mes; lo del mes anterior se mueve a pestañas nuevas ("Bitacora Julio 2026", etc.) en este mismo Sheet.</p>
      <div class="mt-2 rounded-lg px-3 py-2 text-xs font-bold ${estadoTrigger && estadoTrigger.ok && estadoTrigger.instalado ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}">
        ${estadoTrigger && estadoTrigger.ok && estadoTrigger.instalado
          ? "✅ Automatización ACTIVA — corre sola cada día 1 a la 1am. Puedes desactivarla abajo si lo necesitas."
          : "⚠️ Todavía NO está activada — actívala una vez con el botón de abajo."}
      </div>
      <button onclick="${estadoTrigger && estadoTrigger.ok && estadoTrigger.instalado ? "ejecutarDesactivarTriggerArchivo()" : "ejecutarInstalarTriggerArchivo()"}" class="w-full mt-2 ${estadoTrigger && estadoTrigger.ok && estadoTrigger.instalado ? "bg-red-600 hover:bg-red-700" : "bg-sky-600 hover:bg-sky-700"} text-white rounded-lg py-2 text-xs font-bold transition">${estadoTrigger && estadoTrigger.ok && estadoTrigger.instalado ? "Desactivar automatización mensual" : "Activar automatización mensual (una sola vez)"}</button>
      <button onclick="ejecutarArchivarAhora()" class="w-full mt-1.5 bg-white border border-sky-300 hover:bg-sky-100 text-sky-700 rounded-lg py-2 text-xs font-bold transition">Archivar meses anteriores ahora (manual)</button>
      <div id="resultadoArchivado" class="mt-2"></div>
    </div>
    <div class="border border-amber-200 bg-amber-50 rounded-xl p-3 mb-4">
      <p class="text-xs font-bold text-amber-800">🌙 Cierre administrativo de registros</p>
      <p class="text-[11px] text-amber-700 mt-1">Por si seguridad olvidó registrar alguna salida al final del día. Cierra TODO lo que siga activo (todos los deptos y amenidades) marcándolo como "CIERRE ADMIN", no como salida real. Solo funciona de 00:30 a 04:30 am, cuando no hay acceso a amenidades — así no se cierra por error algo del día siguiente.</p>
      <button onclick="ejecutarCierreAdmin()" class="w-full mt-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg py-2 text-xs font-bold transition">Cerrar todos los registros activos</button>
      <div id="resultadoCierreAdmin" class="mt-2"></div>
    </div>
    <div class="grid grid-cols-4 gap-1.5 mb-4">
      ${TABS_ADMIN.map((t, i) => `<button id="tab${t.id}" class="text-[11px] font-bold py-2 rounded-lg transition ${i === 0 ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600"}">${t.label}</button>`).join("")}
    </div>
    <div id="panelReglamento"></div>
    <div id="panelAmenidades" class="hidden"></div>
    <div id="panelMorosos" class="hidden"></div>
    <div id="panelIncidentes" class="hidden"></div>
  `;

  pintarPanelReglamento(regData.articulos || []);
  pintarPanelAmenidades(ameData.amenidades || []);
  pintarPanelMorosos(morData.morosos || []);
  pintarPanelIncidentes(incData.incidentes || []);

  const paneles = { Reg: "panelReglamento", Ame: "panelAmenidades", Mor: "panelMorosos", Inc: "panelIncidentes" };
  TABS_ADMIN.forEach(t => {
    document.getElementById("tab" + t.id).addEventListener("click", () => {
      TABS_ADMIN.forEach(t2 => {
        document.getElementById(paneles[t2.id]).classList.toggle("hidden", t2.id !== t.id);
        document.getElementById("tab" + t2.id).className = "text-[11px] font-bold py-2 rounded-lg transition " + (t2.id === t.id ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600");
      });
    });
  });
}

// Se llama UNA sola vez: deja instalado el trigger que corre solo cada día 1
// del mes. Si se presiona otra vez por error, el backend reemplaza el
// trigger anterior en vez de duplicarlo.
async function ejecutarInstalarTriggerArchivo() {
  const resultado = document.getElementById("resultadoArchivado");
  resultado.innerHTML = `<p class="text-slate-500 text-xs">Activando…</p>`;
  const data = await llamarBackend({ accion: "instalar_trigger_mensual", pin: adminPin });
  if (!data || !data.ok) {
    resultado.innerHTML = `<p class="text-red-600 text-xs font-bold">${escapeHtml(mensajeError(data, "No se pudo activar."))}</p>`;
    return;
  }
  alert("✅ Automatización activada — correrá sola cada día 1 del mes a la 1am.");
  cargarPanelAdmin(); // refresca todo el panel para que el badge de arriba pase a "ACTIVA" de una vez
}

async function ejecutarDesactivarTriggerArchivo() {
  if (!confirm("¿Desactivar la automatización mensual? Bitacora_Reservaciones y Consultas_Seguridad dejarán de vaciarse solas cada día 1 — tendrías que archivar a mano con el botón manual, o volver a activarla después.")) return;
  const resultado = document.getElementById("resultadoArchivado");
  resultado.innerHTML = `<p class="text-slate-500 text-xs">Desactivando…</p>`;
  const data = await llamarBackend({ accion: "desactivar_trigger_mensual", pin: adminPin });
  if (!data || !data.ok) {
    resultado.innerHTML = `<p class="text-red-600 text-xs font-bold">${escapeHtml(mensajeError(data, "No se pudo desactivar."))}</p>`;
    return;
  }
  alert("✅ Automatización desactivada. Lo ya archivado en meses anteriores no se toca.");
  cargarPanelAdmin(); // refresca el panel para que el badge de arriba pase a "NO activa"
}

async function ejecutarArchivarAhora() {
  if (!confirm("¿Archivar ahora todo lo de meses anteriores en Bitacora_Reservaciones y Consultas_Seguridad? Lo activo se queda en vivo, el resto se mueve a pestañas por mes.")) return;
  const resultado = document.getElementById("resultadoArchivado");
  resultado.innerHTML = `<p class="text-slate-500 text-xs">Archivando…</p>`;
  const data = await llamarBackend({ accion: "archivar_mensual_ahora", pin: adminPin });
  if (!data || !data.ok) {
    resultado.innerHTML = `<p class="text-red-600 text-xs font-bold">${escapeHtml(mensajeError(data, "No se pudo archivar."))}</p>`;
    return;
  }
  const bit = data.resultado.bitacora || {};
  const con = data.resultado.consultas || {};
  const partes = [];
  Object.keys(bit).forEach(m => partes.push("Bitácora " + m + ": " + bit[m]));
  Object.keys(con).forEach(m => partes.push("Consultas " + m + ": " + con[m]));
  resultado.innerHTML = partes.length
    ? `<p class="text-emerald-700 text-xs font-bold">✅ Archivado:</p><p class="text-[11px] text-slate-600">${partes.map(escapeHtml).join(" · ")}</p>`
    : `<p class="text-slate-500 text-xs">No había nada de meses anteriores por archivar.</p>`;
}

// Acción destructiva-ish (fuerza salidas sin que seguridad las haya
// registrado): pide confirmación explícita con el PIN de por medio, ya que
// requiere estar en el Panel Admin. El backend valida además la ventana
// horaria (00:30–04:30), así que aunque se presione fuera de horario no pasa
// nada — solo regresa el error explicando por qué no se ejecutó.
async function ejecutarCierreAdmin() {
  if (!confirm("¿Cerrar TODOS los registros activos ahora mismo? Esto marca como salida (etiquetado 'CIERRE ADMIN') a cualquier depto que haya quedado activo sin que seguridad registrara su salida. No se puede deshacer.")) return;
  const resultado = document.getElementById("resultadoCierreAdmin");
  resultado.innerHTML = `<p class="text-slate-500 text-xs">Cerrando…</p>`;
  const data = await llamarBackend({ accion: "cerrar_todos_registros", pin: adminPin });
  if (!data || !data.ok) {
    resultado.innerHTML = `<p class="text-red-600 text-xs font-bold">${escapeHtml(mensajeError(data, "No se pudo ejecutar."))}</p>`;
    return;
  }
  resultado.innerHTML = `<p class="text-emerald-700 text-xs font-bold">✅ Se cerraron ${data.renglonesCerrados} registro(s), ${data.personasCerradas} persona(s) en total.</p>
    ${data.advertencia ? `<p class="text-amber-600 text-[11px] mt-1">⚠️ ${escapeHtml(data.advertencia)}</p>` : ""}`;
  actualizarFabSalida();
}

function pintarPanelReglamento(articulos) {
  const cont = document.getElementById("panelReglamento");

  const porCategoria = {};
  articulos.forEach(a => {
    const cat = a.categoria || "General";
    if (!porCategoria[cat]) porCategoria[cat] = [];
    porCategoria[cat].push(a);
  });
  const categorias = ordenarClavesPorOrdenMinimo(porCategoria, a => a.orden || 0);

  cont.innerHTML = `
    <button id="btnNuevoArticulo" class="w-full mb-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl py-2.5 text-xs font-bold transition">+ Nuevo artículo</button>
    <input id="buscadorAdminReglamento" type="text" placeholder="Filtrar por título o categoría…"
      class="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
    <div id="listaAdminReglamento" class="space-y-2">
      ${categorias.map(cat => `
        <details class="grupo-acordeon-admin border border-slate-200 rounded-xl overflow-hidden">
          <summary class="cursor-pointer select-none list-none flex items-center justify-between px-3 py-2 bg-slate-50 text-xs font-bold text-slate-700">
            <span class="truncate">${escapeHtml(cat)}</span>
            <span class="text-[10px] font-normal text-slate-400 ml-2">${porCategoria[cat].length}</span>
          </summary>
          <div class="p-2 space-y-2">
            ${porCategoria[cat].map(a => `
              <div class="item-admin-buscable border border-slate-200 rounded-xl p-3" data-texto="${escapeHtml((a.titulo + " " + a.categoria).toLowerCase())}">
                <p class="text-xs font-bold text-slate-800">${escapeHtml(a.titulo)}</p>
                <p class="text-xs text-slate-500 mt-1 line-clamp-2">${escapeHtml(a.contenido)}</p>
                <div class="flex gap-2 mt-2">
                  <button class="editArticulo text-[11px] font-bold text-brand-600" data-id="${escapeHtml(a.articuloId)}">Editar</button>
                  <button class="delArticulo text-[11px] font-bold text-red-600" data-id="${escapeHtml(a.articuloId)}">Desactivar</button>
                </div>
              </div>
            `).join("")}
          </div>
        </details>
      `).join("")}
    </div>
  `;
  document.getElementById("btnNuevoArticulo").addEventListener("click", () => formularioArticulo());
  document.getElementById("buscadorAdminReglamento").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll("#listaAdminReglamento .grupo-acordeon-admin").forEach(details => {
      let algunaVisible = false;
      details.querySelectorAll(".item-admin-buscable").forEach(item => {
        const coincide = !q || (item.dataset.texto || "").includes(q);
        item.classList.toggle("hidden", !coincide);
        if (coincide) algunaVisible = true;
      });
      details.classList.toggle("hidden", !algunaVisible);
      if (q) details.open = true;
    });
  });
  cont.querySelectorAll(".editArticulo").forEach(btn => {
    const a = articulos.find(x => x.articuloId === btn.dataset.id);
    btn.addEventListener("click", () => formularioArticulo(a));
  });
  cont.querySelectorAll(".delArticulo").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Desactivar este artículo del reglamento?")) return;
      await llamarBackend({ accion: "eliminar_articulo", pin: adminPin, articuloId: btn.dataset.id });
      cargarPanelAdmin();
      cargarDatos();
    });
  });
}

// Campo con LABEL visible arriba (no solo placeholder) — así al editar algo
// ya llenado, se sabe qué campo es cada uno sin tener que borrar y adivinar.
function campoConLabel(id, label, valor, opciones) {
  opciones = opciones || {};
  const tag = opciones.textarea ? "textarea" : "input";
  const attrsExtra = opciones.textarea ? `rows="${opciones.rows || 3}"` : `type="${opciones.type || "text"}" value="${escapeHtml(valor || "")}"`;
  const contenidoInterno = opciones.textarea ? escapeHtml(valor || "") : "";
  return `
    <div class="mb-2">
      <label class="block text-[11px] font-bold text-slate-500 mb-1">${escapeHtml(label)}</label>
      <${tag} id="${id}" ${attrsExtra} placeholder="${escapeHtml(opciones.placeholder || "")}"
        class="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm">${contenidoInterno}</${tag}>
    </div>
  `;
}

function formularioArticulo(a) {
  const esEdicion = !!a;
  const cont = document.getElementById("panelReglamento");
  cont.innerHTML = `
    <p class="text-sm font-bold text-slate-800 mb-3">${esEdicion ? "Editar" : "Nuevo"} artículo</p>
    ${campoConLabel("fCategoria", "Categoría", esEdicion ? a.categoria : "", { placeholder: "ej. Mascotas" })}
    ${campoConLabel("fTitulo", "Título", esEdicion ? a.titulo : "", { placeholder: "Pregunta o nombre corto de la regla" })}
    ${campoConLabel("fContenido", "Contenido completo de la regla", esEdicion ? a.contenido : "", { textarea: true, rows: 5 })}
    ${campoConLabel("fOrden", "Orden (posición en el menú, opcional)", esEdicion ? a.orden : "", { type: "number" })}
    <div class="flex gap-2 mt-1">
      <button id="fGuardar" class="flex-1 bg-brand-600 hover:bg-brand-700 text-white rounded-xl py-2.5 text-xs font-bold transition">Guardar</button>
      <button id="fCancelar" class="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl py-2.5 text-xs font-bold transition">Cancelar</button>
    </div>
  `;
  document.getElementById("fCancelar").addEventListener("click", () => cargarPanelAdmin());
  document.getElementById("fGuardar").addEventListener("click", async () => {
    const payload = {
      pin: adminPin,
      categoria: document.getElementById("fCategoria").value.trim(),
      titulo: document.getElementById("fTitulo").value.trim(),
      contenido: document.getElementById("fContenido").value.trim(),
      orden: document.getElementById("fOrden").value.trim()
    };
    if (esEdicion) {
      payload.accion = "editar_articulo";
      payload.articuloId = a.articuloId;
    } else {
      payload.accion = "agregar_articulo";
    }
    await llamarBackend(payload);
    cargarPanelAdmin();
    cargarDatos();
  });
}

function pintarPanelAmenidades(amenidades) {
  const cont = document.getElementById("panelAmenidades");

  const porUbicacion = {};
  amenidades.forEach(a => {
    const ubi = a.ubicacion || "General";
    if (!porUbicacion[ubi]) porUbicacion[ubi] = [];
    porUbicacion[ubi].push(a);
  });

  cont.innerHTML = `
    <button id="btnNuevaAmenidad" class="w-full mb-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl py-2.5 text-xs font-bold transition">+ Nueva amenidad</button>
    <input id="buscadorAdminAmenidades" type="text" placeholder="Filtrar por nombre o ubicación…"
      class="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
    <div id="listaAdminAmenidades" class="space-y-2">
      ${Object.keys(porUbicacion).sort().map(ubi => `
        <details class="grupo-acordeon-admin border border-slate-200 rounded-xl overflow-hidden">
          <summary class="cursor-pointer select-none list-none flex items-center justify-between px-3 py-2 bg-slate-50 text-xs font-bold text-slate-700">
            <span class="truncate">${escapeHtml(ubi)}</span>
            <span class="text-[10px] font-normal text-slate-400 ml-2">${porUbicacion[ubi].length}</span>
          </summary>
          <div class="p-2 space-y-2">
            ${porUbicacion[ubi].map(a => `
              <div class="item-admin-buscable border border-slate-200 rounded-xl p-3" data-texto="${escapeHtml((a.nombre + " " + a.ubicacion).toLowerCase())}">
                <p class="text-xs font-bold text-slate-800">${escapeHtml(a.nombre)}</p>
                <p class="text-xs text-slate-500 mt-1">${escapeHtml(a.horarioApertura)}-${escapeHtml(a.horarioCierre)} · ${escapeHtml(a.diasDisponibles || "Todos los días")}</p>
                <div class="flex gap-2 mt-2">
                  <button class="editAmenidad text-[11px] font-bold text-brand-600" data-id="${escapeHtml(a.amenidadId)}">Editar</button>
                  <button class="delAmenidad text-[11px] font-bold text-red-600" data-id="${escapeHtml(a.amenidadId)}">Desactivar</button>
                </div>
              </div>
            `).join("")}
          </div>
        </details>
      `).join("")}
    </div>
  `;
  document.getElementById("btnNuevaAmenidad").addEventListener("click", () => formularioAmenidad());
  document.getElementById("buscadorAdminAmenidades").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll("#listaAdminAmenidades .grupo-acordeon-admin").forEach(details => {
      let algunaVisible = false;
      details.querySelectorAll(".item-admin-buscable").forEach(item => {
        const coincide = !q || (item.dataset.texto || "").includes(q);
        item.classList.toggle("hidden", !coincide);
        if (coincide) algunaVisible = true;
      });
      details.classList.toggle("hidden", !algunaVisible);
      if (q) details.open = true;
    });
  });
  cont.querySelectorAll(".editAmenidad").forEach(btn => {
    const a = amenidades.find(x => x.amenidadId === btn.dataset.id);
    btn.addEventListener("click", () => formularioAmenidad(a));
  });
  cont.querySelectorAll(".delAmenidad").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("¿Desactivar esta amenidad?")) return;
      await llamarBackend({ accion: "eliminar_amenidad", pin: adminPin, amenidadId: btn.dataset.id });
      cargarPanelAdmin();
      cargarDatos();
    });
  });
}

function formularioAmenidad(a) {
  const esEdicion = !!a;
  const cont = document.getElementById("panelAmenidades");
  cont.innerHTML = `
    <p class="text-sm font-bold text-slate-800 mb-3">${esEdicion ? "Editar" : "Nueva"} amenidad</p>
    ${campoConLabel("fNombre", "Nombre de la amenidad", esEdicion ? a.nombre : "", { placeholder: "ej. Alberca" })}
    ${campoConLabel("fUbicacion", "Ubicación", esEdicion ? a.ubicacion : "", { placeholder: "ej. Piso 6" })}
    <div class="grid grid-cols-2 gap-2">
      ${campoConLabel("fApertura", "Hora de apertura", esEdicion ? a.horarioApertura : "", { placeholder: "HH:mm" })}
      ${campoConLabel("fCierre", "Hora de cierre", esEdicion ? a.horarioCierre : "", { placeholder: "HH:mm" })}
    </div>
    ${campoConLabel("fDias", "Días disponibles", esEdicion ? a.diasDisponibles : "", { placeholder: "ej. Todos los días" })}
    ${campoConLabel("fCapacidad", "Capacidad máxima", esEdicion ? a.capacidadMax : "", { placeholder: "ej. 25 personas" })}
    ${campoConLabel("fReservacion", "¿Requiere reservación?", esEdicion ? a.requiereReservacion : "", { placeholder: "Si / No, y con cuánta anticipación" })}
    <p class="text-[11px] font-bold text-slate-500 mt-2 mb-1">Invitados máximos SIN COSTO por tamaño de depto (déjalo vacío si no aplica, o 0 si no se permiten invitados)</p>
    <div class="grid grid-cols-3 gap-2">
      ${campoConLabel("fInvRec1", "1 recámara", esEdicion ? a.invitadosRec1 : "", { type: "number" })}
      ${campoConLabel("fInvRec2", "2 recámaras", esEdicion ? a.invitadosRec2 : "", { type: "number" })}
      ${campoConLabel("fInvRec3", "3 recámaras", esEdicion ? a.invitadosRec3 : "", { type: "number" })}
    </div>
    ${campoConLabel("fRestricciones", "Restricciones", esEdicion ? a.restricciones : "", { textarea: true, rows: 3 })}
    ${campoConLabel("fNotas", "Notas adicionales (opcional)", esEdicion ? a.notas : "", { textarea: true, rows: 2 })}
    <div class="flex gap-2 mt-1">
      <button id="fGuardarAme" class="flex-1 bg-brand-600 hover:bg-brand-700 text-white rounded-xl py-2.5 text-xs font-bold transition">Guardar</button>
      <button id="fCancelarAme" class="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl py-2.5 text-xs font-bold transition">Cancelar</button>
    </div>
  `;
  document.getElementById("fCancelarAme").addEventListener("click", () => cargarPanelAdmin());
  document.getElementById("fGuardarAme").addEventListener("click", async () => {
    const payload = {
      pin: adminPin,
      nombre: document.getElementById("fNombre").value.trim(),
      ubicacion: document.getElementById("fUbicacion").value.trim(),
      horarioApertura: document.getElementById("fApertura").value.trim(),
      horarioCierre: document.getElementById("fCierre").value.trim(),
      diasDisponibles: document.getElementById("fDias").value.trim(),
      capacidadMax: document.getElementById("fCapacidad").value.trim(),
      requiereReservacion: document.getElementById("fReservacion").value.trim(),
      restricciones: document.getElementById("fRestricciones").value.trim(),
      notas: document.getElementById("fNotas").value.trim(),
      invitadosRec1: document.getElementById("fInvRec1").value.trim(),
      invitadosRec2: document.getElementById("fInvRec2").value.trim(),
      invitadosRec3: document.getElementById("fInvRec3").value.trim()
    };
    if (esEdicion) {
      payload.accion = "editar_amenidad";
      payload.amenidadId = a.amenidadId;
    } else {
      payload.accion = "agregar_amenidad";
    }
    await llamarBackend(payload);
    cargarPanelAdmin();
    cargarDatos();
  });
}

// ---------- Panel Morosos (solo lectura + botón refrescar) ----------
function pintarPanelMorosos(morosos) {
  const cont = document.getElementById("panelMorosos");
  cont.innerHTML = `
    <button id="btnRefrescarMorosos" class="w-full mb-3 bg-slate-700 hover:bg-slate-800 text-white rounded-xl py-2.5 text-xs font-bold transition">🔄 Ver el listado más reciente</button>
    <div class="space-y-2">
      ${morosos.length === 0 ? `<p class="text-xs text-slate-500">No hay deptos registrados en la hoja de Morosos.</p>` : morosos.map(m => {
        const esMoroso = m.estatus.toLowerCase() === "moroso";
        return `
        <div class="border rounded-xl p-3 ${esMoroso ? "border-red-200 bg-red-50" : "border-emerald-200 bg-emerald-50"}">
          <div class="flex items-center justify-between">
            <p class="text-xs font-bold text-slate-800">Depto ${escapeHtml(m.depto)}</p>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${esMoroso ? "bg-red-600 text-white" : "bg-emerald-600 text-white"}">${escapeHtml(m.estatus)}</span>
          </div>
          ${esMoroso ? `<p class="text-[11px] text-slate-600 mt-1">Avisos emitidos: <b>${m.avisosEmitidos}</b>${m.vecesBloqueado ? " · Veces bloqueado: " + m.vecesBloqueado : ""}</p>` : ""}
          <p class="text-[11px] text-slate-600 mt-1">Convenio de pago: <b>${escapeHtml(m.tieneConvenio)}</b>${m.detalleConvenio ? " — " + escapeHtml(m.detalleConvenio) : ""}</p>
          ${m.ultimaActualizacion ? `<p class="text-[10px] text-slate-400 mt-1">Actualizado: ${escapeHtml(m.ultimaActualizacion)}</p>` : ""}
        </div>
      `;}).join("")}
    </div>
  `;
  document.getElementById("btnRefrescarMorosos").addEventListener("click", async () => {
    const data = await llamarBackend({ accion: "listar_morosos", pin: adminPin });
    pintarPanelMorosos(data.morosos || []);
  });
}

// ---------- Panel Incidentes (solo lectura + marcar revisado) ----------
function pintarPanelIncidentes(incidentes) {
  const cont = document.getElementById("panelIncidentes");
  cont.innerHTML = `
    <div class="space-y-2">
      ${incidentes.length === 0 ? `<p class="text-xs text-slate-500">Sin incidentes registrados.</p>` : incidentes.map(i => `
        <div class="border rounded-xl p-3 ${i.estado === "Revisado" ? "border-slate-200" : "border-amber-300 bg-amber-50"}">
          <div class="flex items-center justify-between">
            <p class="text-xs font-bold text-slate-800">Depto ${escapeHtml(i.depto)}</p>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${i.estado === "Revisado" ? "bg-slate-400 text-white" : "bg-amber-500 text-white"}">${escapeHtml(i.estado)}</span>
          </div>
          <p class="text-xs text-slate-600 mt-1">${escapeHtml(i.descripcion)}</p>
          ${i.reglaViolada ? `<p class="text-[11px] text-slate-500 mt-1"><b>Regla:</b> ${escapeHtml(i.reglaViolada)}</p>` : ""}
          ${i.evidenciaUrl ? `<a href="${escapeHtml(i.evidenciaUrl)}" target="_blank" class="text-[11px] text-brand-600 font-bold underline mt-1 inline-block">Ver evidencia</a>` : ""}
          <p class="text-[10px] text-slate-400 mt-1">Reportó: ${escapeHtml(i.guardiaNombre || "—")}${i.guardiaPuesto ? " (" + escapeHtml(i.guardiaPuesto) + ")" : ""} · ${escapeHtml(i.timestamp)}</p>
          ${i.estado !== "Revisado" ? `<button class="marcarRevisado text-[11px] font-bold text-brand-600 mt-2" data-id="${escapeHtml(i.incidenteId)}">Marcar como revisado</button>` : ""}
        </div>
      `).join("")}
    </div>
  `;
  cont.querySelectorAll(".marcarRevisado").forEach(btn => {
    btn.addEventListener("click", async () => {
      await llamarBackend({ accion: "marcar_incidente_revisado", pin: adminPin, incidenteId: btn.dataset.id });
      cargarPanelAdmin();
    });
  });
}

// ---------- Inicio ----------
cargarDatos();
cargarGuardias().finally(() => {
  actualizarBadgeGuardia();
  if (!guardNombre) {
    abrirModalIdentidad();
  } else {
    mostrarBienvenida();
  }
});
actualizarFabSalida();
setInterval(actualizarFabSalida, 90000); // por si otro guardia registra/saca desde otra sesión