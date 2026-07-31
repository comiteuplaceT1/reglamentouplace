// =========================================================================
// AGENTE DE REGLAMENTO Y AMENIDADES — UPLACE Torre 1
// CSV publicado para lectura, Apps Script (GET/POST) para escritura/admin,
// parser CSV RFC4180 char-by-char.
// =========================================================================

const CONFIG = {
  CSV_REGLAMENTO: "https://docs.google.com/spreadsheets/d/e/2PACX-1vTxhkaosS4qRt2kAyS1deAd1asEokZpN64gL26nsvBlZ-pk9pGmsurudUhxshUMxFDwqHuZkdImQso6/pub?gid=0&single=true&output=csv",
  CSV_AMENIDADES: "https://docs.google.com/spreadsheets/d/e/2PACX-1vTxhkaosS4qRt2kAyS1deAd1asEokZpN64gL26nsvBlZ-pk9pGmsurudUhxshUMxFDwqHuZkdImQso6/pub?gid=1334902608&single=true&output=csv",
  WEBAPP_URL: "https://script.google.com/macros/s/AKfycbyYi_rh8gDE-nlZVN0BNURME5_dy2XuXFRr_U9iBtZXYsq7NW6b5IvE9afGCiVmuJf27g/exec"
};

let reglamentoData = [];
let amenidadesData = [];
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
  // ---------- Reglamento agrupado por Categoria ----------
  const porCategoria = {};
  reglamentoData.forEach(a => {
    const cat = a.Categoria || "General";
    if (!porCategoria[cat]) porCategoria[cat] = [];
    porCategoria[cat].push(a);
  });

  const contReg = document.getElementById("reglamentoList");
  contReg.innerHTML = "";
  const categorias = ordenarClavesPorOrdenMinimo(porCategoria, a => Number(a.Orden) || 0);
  categorias.forEach((cat, idx) => {
    const details = document.createElement("details");
    details.className = "grupo-acordeon border border-slate-200 rounded-xl overflow-hidden";
    if (idx === 0) details.open = true;

    const cantidad = porCategoria[cat].length;
    const summary = document.createElement("summary");
    summary.className = "cursor-pointer select-none list-none flex items-center justify-between px-3 py-2 bg-slate-50 hover:bg-slate-100 text-xs font-bold text-slate-700 transition";
    summary.innerHTML = `<span class="truncate">${escapeHtml(cat)}</span>
      <span class="shrink-0 text-[10px] font-normal text-slate-400 ml-2">${cantidad}</span>`;
    details.appendChild(summary);

    const cuerpo = document.createElement("div");
    cuerpo.className = "px-1.5 py-1.5 space-y-0.5 bg-white";
    porCategoria[cat]
      .sort((a, b) => (Number(a.Orden) || 0) - (Number(b.Orden) || 0))
      .forEach(a => {
        const btn = document.createElement("button");
        btn.className = "item-buscable w-full text-left text-xs text-slate-700 hover:bg-slate-100 rounded-lg px-3 py-2 transition";
        btn.textContent = a.Titulo;
        btn.dataset.texto = (a.Titulo + " " + a.Categoria + " " + a.Contenido).toLowerCase();
        btn.onclick = () => mostrarDetalleArticulo(a);
        cuerpo.appendChild(btn);
      });
    details.appendChild(cuerpo);
    contReg.appendChild(details);
  });

  // ---------- Amenidades agrupadas por Ubicación ----------
  const porUbicacion = {};
  amenidadesData.forEach(a => {
    const ubi = a.Ubicacion || "General";
    if (!porUbicacion[ubi]) porUbicacion[ubi] = [];
    porUbicacion[ubi].push(a);
  });

  const contAme = document.getElementById("amenidadesList");
  contAme.innerHTML = "";
  Object.keys(porUbicacion).sort().forEach((ubi, idx) => {
    const details = document.createElement("details");
    details.className = "grupo-acordeon border border-slate-200 rounded-xl overflow-hidden";
    if (idx === 0) details.open = true;

    const summary = document.createElement("summary");
    summary.className = "cursor-pointer select-none list-none flex items-center justify-between px-3 py-2 bg-slate-50 hover:bg-slate-100 text-xs font-bold text-slate-700 transition";
    summary.innerHTML = `<span class="truncate">${escapeHtml(ubi)}</span>
      <span class="shrink-0 text-[10px] font-normal text-slate-400 ml-2">${porUbicacion[ubi].length}</span>`;
    details.appendChild(summary);

    const cuerpo = document.createElement("div");
    cuerpo.className = "px-1.5 py-1.5 space-y-0.5 bg-white";
    porUbicacion[ubi].forEach(a => {
      const btn = document.createElement("button");
      // Nombre y horario APILADOS (no en la misma línea) para que el nombre
      // nunca se recorte y solo se agregue el dato de horario, nada más.
      btn.className = "item-buscable w-full text-left text-xs text-slate-700 hover:bg-slate-100 rounded-lg px-3 py-2 transition";
      btn.innerHTML = `<div class="font-semibold text-slate-800">${escapeHtml(a.Nombre)}</div>
        <div class="text-[10px] text-slate-400 mt-0.5">${escapeHtml(a.HorarioApertura || "")} – ${escapeHtml(a.HorarioCierre || "")}</div>`;
      btn.dataset.texto = (a.Nombre + " " + a.Ubicacion + " " + a.Restricciones).toLowerCase();
      btn.onclick = () => mostrarDetalleAmenidad(a);
      cuerpo.appendChild(btn);
    });
    details.appendChild(cuerpo);
    contAme.appendChild(details);
  });
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
  document.getElementById("fIdentidadNombre").value = guardNombre || "";
  document.getElementById("fIdentidadPuesto").value = guardPuesto || "Guardia de Turno";
  document.getElementById("modalIdentidad").classList.remove("hidden");
}
function cerrarModalIdentidad() {
  // Solo se puede cerrar si ya hay una identidad guardada (no se puede usar
  // el chat de forma anónima, para que las consultas queden a nombre de alguien).
  if (guardNombre) document.getElementById("modalIdentidad").classList.add("hidden");
}
function guardarIdentidad() {
  const nombre = document.getElementById("fIdentidadNombre").value.trim();
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
}
function cambiarGuardia() {
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
});
function cerrarSidebar() {
  sidebar.classList.add("-translate-x-full");
  overlay.classList.add("hidden");
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
  document.getElementById("fConsultaInvitados").value = "";
  document.getElementById("resultadoConsultaDepto").innerHTML = "";
  document.getElementById("modalConsultarDepto").classList.remove("hidden");
  setTimeout(() => document.getElementById("fConsultaDepto").focus(), 100);
}
function cerrarModalConsultarDepto() { document.getElementById("modalConsultarDepto").classList.add("hidden"); }

let ultimaConsultaDepto = null; // guarda el resultado para poder "registrar ingreso" después

async function ejecutarConsultaDepto() {
  const depto = document.getElementById("fConsultaDepto").value.trim();
  const amenidadId = document.getElementById("fConsultaAmenidad").value;
  const numInvitados = document.getElementById("fConsultaInvitados").value.trim();
  const resultado = document.getElementById("resultadoConsultaDepto");

  if (!depto) { resultado.innerHTML = `<p class="text-red-600 text-xs">Escribe el número de depto.</p>`; return; }
  resultado.innerHTML = `<p class="text-slate-500 text-xs">Consultando…</p>`;

  const data = await llamarBackend({
    accion: "verificar_acceso",
    depto: depto,
    amenidadId: amenidadId,
    numInvitados: numInvitados,
    guardiaNombre: guardNombre,
    guardiaPuesto: guardPuesto
  });

  if (!data.ok) {
    resultado.innerHTML = `<p class="text-red-600 text-xs">${escapeHtml(data.error || "Error al consultar.")}</p>`;
    return;
  }
  ultimaConsultaDepto = { depto, amenidadId, numInvitados, data };

  const m = data.moroso;
  let colorMoroso = "bg-emerald-50 border-emerald-200 text-emerald-800";
  let tituloMoroso = "✅ Al corriente";
  if (m.accion === "aviso") { colorMoroso = "bg-amber-50 border-amber-300 text-amber-800"; tituloMoroso = "⚠️ MOROSO — primer aviso, se le permite pasar"; }
  if (m.accion === "bloqueado") { colorMoroso = "bg-red-50 border-red-300 text-red-800"; tituloMoroso = "🚫 MOROSO — BLOQUEADO, no permitir acceso"; }
  else if (m.estatus && m.estatus.toLowerCase() === "moroso" && m.accion === "ninguna") { colorMoroso = "bg-amber-50 border-amber-300 text-amber-800"; tituloMoroso = "⚠️ Moroso"; }

  let html = `
    <div class="border rounded-xl p-3 ${colorMoroso}">
      <p class="text-xs font-bold">${tituloMoroso}</p>
      <p class="text-xs mt-1">${escapeHtml(m.mensaje)}</p>
      ${m.tieneConvenio && m.tieneConvenio.toLowerCase() === "si" ? `<p class="text-xs mt-1"><b>Tiene convenio de pago:</b> ${escapeHtml(m.detalleConvenio || "Sin detalle registrado")}</p>` : ""}
    </div>
    <div class="border border-slate-200 rounded-xl p-3 mt-2">
      <p class="text-xs text-slate-700"><b>Depto ${escapeHtml(depto)}</b>${data.recamaras ? " · " + data.recamaras + " recámara(s)" : " · recámaras no registradas"}</p>
      ${!data.deptoEncontrado ? `<p class="text-[11px] text-amber-600 mt-1">Este depto no está en el padrón — verifica manualmente los datos.</p>` : ""}
    </div>
  `;

  if (data.amenidad) {
    const am = data.amenidad;
    let permitidoTxt = "";
    if (am.limiteInvitados === null) {
      permitidoTxt = `<p class="text-xs text-slate-600 mt-1">Sin límite de invitados registrado por recámara para esta amenidad — revisa las restricciones abajo.</p>`;
    } else {
      const ok = am.permitido;
      permitidoTxt = `<p class="text-xs mt-1 font-bold ${ok ? "text-emerald-700" : "text-red-700"}">
        ${am.invitadosSolicitados !== null ? (ok ? "✅ Puede pasar con sus " + am.invitadosSolicitados + " invitado(s)" : "🚫 Excede el límite de invitados") : "Máximo " + am.limiteInvitados + " invitado(s) para este depto"}
      </p>`;
    }
    html += `
      <div class="border border-slate-200 rounded-xl p-3 mt-2">
        <p class="text-xs font-bold text-slate-800">${escapeHtml(am.nombre)}</p>
        <p class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(am.horario)} · ${escapeHtml(am.dias)}</p>
        ${permitidoTxt}
        <p class="text-[11px] text-slate-500 mt-1 whitespace-pre-line">${escapeHtml(am.restricciones)}</p>
        <button onclick="registrarIngresoAmenidad()" class="w-full mt-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg py-2 text-xs font-bold transition">✅ Registrar ingreso a esta amenidad</button>
      </div>
    `;
  }

  resultado.innerHTML = html;
}

async function registrarIngresoAmenidad() {
  if (!ultimaConsultaDepto || !ultimaConsultaDepto.data.amenidad) return;
  const { depto, numInvitados, data } = ultimaConsultaDepto;
  await llamarBackend({
    accion: "registrar_reservacion",
    depto: depto,
    amenidad: data.amenidad.nombre,
    numInvitados: numInvitados || "0",
    guardiaNombre: guardNombre,
    guardiaPuesto: guardPuesto
  });
  document.getElementById("resultadoConsultaDepto").insertAdjacentHTML("beforeend",
    `<p class="text-emerald-700 text-xs font-bold mt-2">✅ Ingreso registrado en la bitácora.</p>`);
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
  const [regData, ameData, morData, incData] = await Promise.all([
    llamarBackend({ accion: "listar_reglamento", pin: adminPin }),
    llamarBackend({ accion: "listar_amenidades", pin: adminPin }),
    llamarBackend({ accion: "listar_morosos", pin: adminPin }),
    llamarBackend({ accion: "listar_incidentes", pin: adminPin })
  ]);

  const body = document.getElementById("adminBody");
  body.innerHTML = `
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
actualizarBadgeGuardia();
if (!guardNombre) {
  abrirModalIdentidad();
} else {
  pintarMensaje("Hola " + guardNombre.split(" ")[0] + ", soy el Agente de Reglamento y Amenidades de UPLACE Torre 1. Pregúntame qué se puede o no se puede, consulta un horario, o usa \"Consultar depto\" para verificar morosidad e invitados.", "bot");
}
