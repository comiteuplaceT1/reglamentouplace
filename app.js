// =========================================================================
// AGENTE DE REGLAMENTO Y AMENIDADES — UPLACE Torre 1
// Mismo patrón que agenteEventos: CSV publicado para lectura, Apps Script
// (GET) para escritura/admin, parser CSV RFC4180 char-by-char (soporta
// contenido multilínea en la columna Contenido/Restricciones/Notas).
// =========================================================================

const CONFIG = {
  // Reemplaza estas URLs por las de "Archivo -> Compartir -> Publicar en la
  // web" de CADA pestaña (Reglamento Interno / Amenidades y Horarios),
  // exportadas como CSV. Cada pestaña tiene su propio gid.
CSV_REGLAMENTO: "https://docs.google.com/spreadsheets/d/e/2PACX-1vTxhkaosS4qRt2kAyS1deAd1asEokZpN64gL26nsvBlZ-pk9pGmsurudUhxshUMxFDwqHuZkdImQso6/pub?gid=0&single=true&output=csv",
CSV_AMENIDADES: "https://docs.google.com/spreadsheets/d/e/2PACX-1vTxhkaosS4qRt2kAyS1deAd1asEokZpN64gL26nsvBlZ-pk9pGmsurudUhxshUMxFDwqHuZkdImQso6/pub?gid=1334902608&single=true&output=csv",
  // URL de la implementación del Web App (Codigo.gs) — la misma para chat y admin.
  WEBAPP_URL: "https://script.google.com/macros/s/AKfycbxmMvgJIvJgjRueXq2mu8mDYc-x20PUhgPPBkLqy1uw3NccEVlt-XAo532ohqY4J7I6RA/exec"
};

let reglamentoData = [];
let amenidadesData = [];
let adminPin = null;

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
    document.getElementById("edificioSummary").textContent =
      reglamentoData.length + " artículos · " + amenidadesData.length + " amenidades";
  } catch (err) {
    console.error("Error cargando datos:", err);
    document.getElementById("edificioSummary").textContent = "Error al cargar datos";
  }
}

// Sidebar en acordeón: cada categoría/ubicación es un <details> colapsado por
// default, así el menú no se siente interminable. Se abre el primero solo
// para dar la pista de que es clickeable.
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
  const categorias = Object.keys(porCategoria).sort();
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
      btn.className = "item-buscable w-full text-left text-xs text-slate-700 hover:bg-slate-100 rounded-lg px-3 py-2 transition flex items-center justify-between gap-2";
      btn.innerHTML = `<span class="truncate">${escapeHtml(a.Nombre)}</span>
        <span class="shrink-0 text-[10px] text-slate-400">${escapeHtml(a.HorarioApertura || "")}-${escapeHtml(a.HorarioCierre || "")}</span>`;
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
  document.getElementById("modalDetalleTitulo").textContent = a.Nombre;
  document.getElementById("modalDetalleBody").innerHTML = `
    <p class="mb-1"><b>Ubicación:</b> ${escapeHtml(a.Ubicacion || "-")}</p>
    <p class="mb-1"><b>Horario:</b> ${escapeHtml(a.HorarioApertura || "-")} a ${escapeHtml(a.HorarioCierre || "-")}</p>
    <p class="mb-1"><b>Días disponibles:</b> ${escapeHtml(a.DiasDisponibles || "Todos")}</p>
    <p class="mb-1"><b>Capacidad:</b> ${escapeHtml(a.CapacidadMax || "Sin límite")}</p>
    <p class="mb-1"><b>¿Requiere reservación?:</b> ${escapeHtml(a.RequiereReservacion || "No")}</p>
    <p class="mb-1"><b>Restricciones:</b> <span class="whitespace-pre-line">${escapeHtml(a.Restricciones || "Ninguna")}</span></p>
    ${a.Notas ? `<p class="mt-2 text-slate-500 whitespace-pre-line"><b>Notas:</b> ${escapeHtml(a.Notas)}</p>` : ""}
  `;
  document.getElementById("modalDetalle").classList.remove("hidden");
}

function cerrarModalDetalle() { document.getElementById("modalDetalle").classList.add("hidden"); }

// Referencia rápida de TODOS los horarios: se arma directo de los datos ya
// cargados del Sheet (sin llamar a la IA), así siempre es exacta e instantánea
// — resuelve justo el caso de "¿qué está abierto ahorita?" que la IA no puede
// contestar bien porque no tiene la hora actual.
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
  pintarMensaje(pregunta, "user");
  pintarTyping();
  try {
    const data = await llamarBackend({ accion: "chat", pregunta: pregunta });
    quitarTyping();
    if (data.error) {
      pintarMensaje("No pude conectarme con el reglamento en este momento. Por favor contacta al Jefe de Turno o al Comité directamente.", "bot");
    } else {
      pintarMensaje(data.respuesta_ia, "bot");
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

async function cargarPanelAdmin() {
  document.getElementById("adminBody").innerHTML = `<p class="text-sm text-slate-500">Cargando…</p>`;
  const [regData, ameData] = await Promise.all([
    llamarBackend({ accion: "listar_reglamento", pin: adminPin }),
    llamarBackend({ accion: "listar_amenidades", pin: adminPin })
  ]);

  const body = document.getElementById("adminBody");
  body.innerHTML = `
    <div class="flex gap-2 mb-4">
      <button id="tabReg" class="flex-1 text-xs font-bold py-2 rounded-lg bg-brand-600 text-white">Reglamento</button>
      <button id="tabAme" class="flex-1 text-xs font-bold py-2 rounded-lg bg-slate-100 text-slate-600">Amenidades</button>
    </div>
    <div id="panelReglamento"></div>
    <div id="panelAmenidades" class="hidden"></div>
  `;

  pintarPanelReglamento(regData.articulos || []);
  pintarPanelAmenidades(ameData.amenidades || []);

  document.getElementById("tabReg").addEventListener("click", () => {
    document.getElementById("panelReglamento").classList.remove("hidden");
    document.getElementById("panelAmenidades").classList.add("hidden");
    document.getElementById("tabReg").className = "flex-1 text-xs font-bold py-2 rounded-lg bg-brand-600 text-white";
    document.getElementById("tabAme").className = "flex-1 text-xs font-bold py-2 rounded-lg bg-slate-100 text-slate-600";
  });
  document.getElementById("tabAme").addEventListener("click", () => {
    document.getElementById("panelAmenidades").classList.remove("hidden");
    document.getElementById("panelReglamento").classList.add("hidden");
    document.getElementById("tabAme").className = "flex-1 text-xs font-bold py-2 rounded-lg bg-brand-600 text-white";
    document.getElementById("tabReg").className = "flex-1 text-xs font-bold py-2 rounded-lg bg-slate-100 text-slate-600";
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

  cont.innerHTML = `
    <button id="btnNuevoArticulo" class="w-full mb-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl py-2.5 text-xs font-bold transition">+ Nuevo artículo</button>
    <input id="buscadorAdminReglamento" type="text" placeholder="Filtrar por título o categoría…"
      class="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500/40" />
    <div id="listaAdminReglamento" class="space-y-2">
      ${Object.keys(porCategoria).sort().map(cat => `
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

function formularioArticulo(a) {
  const esEdicion = !!a;
  const cont = document.getElementById("panelReglamento");
  cont.innerHTML = `
    <p class="text-sm font-bold text-slate-800 mb-3">${esEdicion ? "Editar" : "Nuevo"} artículo</p>
    <input id="fCategoria" placeholder="Categoría (ej. Mascotas)" value="${esEdicion ? escapeHtml(a.categoria) : ""}"
      class="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm mb-2" />
    <input id="fTitulo" placeholder="Título" value="${esEdicion ? escapeHtml(a.titulo) : ""}"
      class="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm mb-2" />
    <textarea id="fContenido" placeholder="Contenido completo de la regla" rows="5"
      class="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm mb-2">${esEdicion ? escapeHtml(a.contenido) : ""}</textarea>
    <input id="fOrden" type="number" placeholder="Orden (opcional)" value="${esEdicion ? a.orden : ""}"
      class="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm mb-3" />
    <div class="flex gap-2">
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
    <input id="fNombre" placeholder="Nombre (ej. Alberca)" value="${esEdicion ? escapeHtml(a.nombre) : ""}"
      class="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm mb-2" />
    <input id="fUbicacion" placeholder="Ubicación (ej. Piso 6)" value="${esEdicion ? escapeHtml(a.ubicacion) : ""}"
      class="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm mb-2" />
    <div class="flex gap-2 mb-2">
      <input id="fApertura" placeholder="Apertura (HH:mm)" value="${esEdicion ? escapeHtml(a.horarioApertura) : ""}"
        class="w-1/2 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
      <input id="fCierre" placeholder="Cierre (HH:mm)" value="${esEdicion ? escapeHtml(a.horarioCierre) : ""}"
        class="w-1/2 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
    </div>
    <input id="fDias" placeholder="Días disponibles (ej. Todos los días)" value="${esEdicion ? escapeHtml(a.diasDisponibles) : ""}"
      class="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm mb-2" />
    <input id="fCapacidad" placeholder="Capacidad máxima" value="${esEdicion ? escapeHtml(a.capacidadMax) : ""}"
      class="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm mb-2" />
    <input id="fReservacion" placeholder="¿Requiere reservación? (Si/No)" value="${esEdicion ? escapeHtml(a.requiereReservacion) : ""}"
      class="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm mb-2" />
    <textarea id="fRestricciones" placeholder="Restricciones" rows="3"
      class="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm mb-2">${esEdicion ? escapeHtml(a.restricciones) : ""}</textarea>
    <textarea id="fNotas" placeholder="Notas adicionales (opcional)" rows="2"
      class="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm mb-3">${esEdicion ? escapeHtml(a.notas) : ""}</textarea>
    <div class="flex gap-2">
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
      notas: document.getElementById("fNotas").value.trim()
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

// ---------- Inicio ----------
cargarDatos();
pintarMensaje("Hola, soy el Agente de Reglamento y Amenidades de UPLACE Torre 1. Pregúntame qué se puede o no se puede, o consulta un horario.", "bot");