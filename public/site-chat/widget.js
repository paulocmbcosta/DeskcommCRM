/*
 * Chat do site — o widget que o dono cola no próprio site.
 *
 *   <script async src="https://SEU-CRM/site-chat/widget.js" data-widget-key="wc_..."></script>
 *
 * Um arquivo só, sem dependência e sem build: ele roda no site de TERCEIROS, onde
 * não controlamos framework, CSP nem versão de nada.
 *
 * Shadow DOM, e não iframe, por dois motivos medidos:
 *   1. o CRM responde `X-Frame-Options: DENY` em toda rota (next.config.ts);
 *   2. o token do visitante mora no localStorage do SITE (primeira parte). Dentro
 *      de um iframe ele seria armazenamento de terceiro, que o Safari particiona
 *      e apaga — o visitante perderia a conversa ao trocar de página.
 *
 * Nenhuma marca mora aqui (white-label): título, cor e textos vêm da configuração
 * do canal, e os textos FIXOS abaixo não nomeiam produto nenhum.
 *
 * Todo texto entra por `textContent`. Não há `innerHTML` com dado de fora — o
 * que o atendente escreve e o que a configuração traz são dados, nunca marcação.
 */
(function () {
  "use strict";

  if (window.__siteChatCarregado) return;
  window.__siteChatCarregado = true;

  var script = document.currentScript || document.querySelector("script[data-widget-key]");
  if (!script) return;
  var chave = script.getAttribute("data-widget-key") || "";
  if (!/^wc_[a-zA-Z0-9]{24}$/.test(chave)) {
    console.warn("[site-chat] data-widget-key ausente ou inválido — o widget não foi carregado.");
    return;
  }

  var base;
  try {
    base = new URL(script.src).origin;
  } catch (e) {
    return;
  }
  var API = base + "/api/v1/site-chat/" + encodeURIComponent(chave);
  var GUARDA = "site-chat:" + chave;

  var TEXTOS = {
    pt: {
      abrir: "Abrir chat",
      fechar: "Fechar chat",
      nome: "Seu nome",
      email: "Seu e-mail",
      telefone: "Seu WhatsApp ou telefone",
      opcional: "opcional",
      mensagem: "Escreva sua mensagem…",
      comecar: "Iniciar conversa",
      enviar: "Enviar",
      enviando: "Enviando…",
      falhou: "Não enviada. Toque para tentar de novo.",
      obrigatorio: "Preencha este campo.",
      emailInvalido: "E-mail inválido.",
      telefoneInvalido: "Telefone inválido — inclua o DDD.",
      semConexao: "Sem conexão. Tentando de novo…",
      muitoRapido: "Muitas mensagens em pouco tempo. Aguarde um instante.",
      arquivo: "Abrir arquivo",
      novas: "mensagens novas",
    },
    es: {
      abrir: "Abrir chat",
      fechar: "Cerrar chat",
      nome: "Tu nombre",
      email: "Tu correo",
      telefone: "Tu WhatsApp o teléfono",
      opcional: "opcional",
      mensagem: "Escribe tu mensaje…",
      comecar: "Iniciar conversación",
      enviar: "Enviar",
      enviando: "Enviando…",
      falhou: "No enviado. Toca para reintentar.",
      obrigatorio: "Completa este campo.",
      emailInvalido: "Correo inválido.",
      telefoneInvalido: "Teléfono inválido — incluye el código de área.",
      semConexao: "Sin conexión. Reintentando…",
      muitoRapido: "Demasiados mensajes en poco tiempo. Espera un momento.",
      arquivo: "Abrir archivo",
      novas: "mensajes nuevos",
    },
    en: {
      abrir: "Open chat",
      fechar: "Close chat",
      nome: "Your name",
      email: "Your email",
      telefone: "Your WhatsApp or phone",
      opcional: "optional",
      mensagem: "Type your message…",
      comecar: "Start conversation",
      enviar: "Send",
      enviando: "Sending…",
      falhou: "Not sent. Tap to retry.",
      obrigatorio: "Please fill in this field.",
      emailInvalido: "Invalid email.",
      telefoneInvalido: "Invalid phone — include the area code.",
      semConexao: "No connection. Retrying…",
      muitoRapido: "Too many messages in a short time. Please wait a moment.",
      arquivo: "Open file",
      novas: "new messages",
    },
  };

  // ── Estado ────────────────────────────────────────────────────────────────

  var cfg = null;
  var t = TEXTOS.pt;
  var token = null;
  var aberto = false;
  var naoLidas = 0;
  var mensagens = []; // { id, clientId, direction, type, body, media, at, estado }
  var vistos = Object.create(null); // id do servidor → true
  var cursor = null; // created_at da última mensagem do servidor
  // Até onde o visitante JÁ VIU (created_at). Sobrevive à troca de página: sem
  // isto, cada recarga relê o histórico e o selo de "não lidas" contaria todas
  // as respostas antigas de novo — o visitante que volta veria "9+" num chat em
  // que não há nada de novo.
  var vistoAte = null;
  var relogio = null;
  var falhasSeguidas = 0;
  var enviando = false;
  var el = {};

  function lerGuarda() {
    try {
      var bruto = window.localStorage.getItem(GUARDA);
      if (!bruto) return null;
      var o = JSON.parse(bruto);
      return o && typeof o.t === "string" ? o : null;
    } catch (e) {
      return null;
    }
  }

  function gravarGuarda() {
    try {
      if (token) window.localStorage.setItem(GUARDA, JSON.stringify({ t: token, v: vistoAte }));
      else window.localStorage.removeItem(GUARDA);
    } catch (e) {
      /* navegação privada sem storage: a conversa vive só nesta página. */
    }
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    var b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [];
    for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join("") + "-" + h.slice(4, 6).join("") + "-" + h.slice(6, 8).join("") + "-" +
      h.slice(8, 10).join("") + "-" + h.slice(10, 16).join("");
  }

  // ── Rede ──────────────────────────────────────────────────────────────────

  function pedir(metodo, caminho, corpo) {
    var headers = { Accept: "application/json" };
    if (corpo) headers["Content-Type"] = "application/json";
    // O token vai em HEADER, nunca na URL: query string fica em log de proxy.
    if (token) headers["X-Visitor-Token"] = token;
    return fetch(API + caminho, {
      method: metodo,
      headers: headers,
      body: corpo ? JSON.stringify(corpo) : undefined,
      credentials: "omit",
      mode: "cors",
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return null;
        })
        .then(function (json) {
          return { status: res.status, ok: res.ok, json: json };
        });
    });
  }

  // ── DOM ───────────────────────────────────────────────────────────────────

  function criar(tag, attrs, filhos) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === "text") n.textContent = attrs[k];
        else if (k === "class") n.className = attrs[k];
        else n.setAttribute(k, attrs[k]);
      }
    }
    (filhos || []).forEach(function (f) {
      if (f) n.appendChild(f);
    });
    return n;
  }

  function svg(caminho) {
    var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", "24");
    s.setAttribute("height", "24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", caminho);
    s.appendChild(p);
    return s;
  }

  var ICONE_CHAT = "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z";
  var ICONE_FECHAR = "M18 6 6 18M6 6l12 12";
  var ICONE_ENVIAR = "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z";

  var CSS = [
    ":host{all:initial}",
    // `hidden` PRECISA vencer. O atributo vale `display:none` só na folha de estilo
    // do navegador, e qualquer `display:flex` abaixo o derrota em silêncio: a área
    // de conversa "escondida" seguia ocupando metade do painel e empurrava o
    // telefone, a mensagem e o botão do formulário para fora da vista. Uma regra
    // só, para todo elemento — em vez de um `[hidden]` por classe, que é a lista
    // que alguém esquece de completar (foi exatamente o que aconteceu).
    "[hidden]{display:none !important}",
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}",
    ".raiz{position:fixed;bottom:20px;z-index:2147483000;color:#111827;font-size:14px;line-height:1.45}",
    ".raiz.direita{right:20px}.raiz.esquerda{left:20px}",
    ".lancador{width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;",
    "background:var(--cor);color:var(--frente);box-shadow:0 6px 20px rgba(0,0,0,.25);position:relative;transition:transform .15s ease}",
    ".lancador:hover{transform:scale(1.05)}",
    ".lancador:focus-visible,.botao:focus-visible,.fechar:focus-visible,.enviar:focus-visible{outline:3px solid var(--cor);outline-offset:2px}",
    ".selo{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#dc2626;color:#fff;",
    "font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center}",
    ".painel{position:absolute;bottom:72px;width:380px;max-width:calc(100vw - 40px);height:600px;max-height:calc(100vh - 112px);",
    "background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden}",
    ".direita .painel{right:0}.esquerda .painel{left:0}",
    ".topo{background:var(--cor);color:var(--frente);padding:16px 48px 16px 18px;position:relative;flex:none}",
    ".titulo{font-size:16px;font-weight:600;margin:0}",
    ".subtitulo{font-size:13px;opacity:.9;margin:2px 0 0}",
    ".fechar{position:absolute;top:12px;right:12px;width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;",
    "display:flex;align-items:center;justify-content:center}",
    ".fechar:hover{background:rgba(127,127,127,.25)}",
    ".corpo{flex:1;overflow-y:auto;padding:16px;background:#f9fafb;display:flex;flex-direction:column;gap:8px;overscroll-behavior:contain}",
    ".msg{max-width:82%;display:flex;flex-direction:column;gap:2px}",
    ".msg.deles{align-self:flex-start}.msg.minha{align-self:flex-end;align-items:flex-end}",
    ".balao{padding:9px 13px;border-radius:16px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}",
    ".deles .balao{background:#fff;border:1px solid #e5e7eb;border-bottom-left-radius:4px}",
    ".minha .balao{background:var(--cor);color:var(--frente);border-bottom-right-radius:4px}",
    ".minha .balao a{color:inherit}",
    ".balao a{color:#1d4ed8;text-decoration:underline}",
    ".balao img,.balao video{display:block;max-width:100%;border-radius:10px}",
    ".balao audio{max-width:100%}",
    ".hora{font-size:11px;color:#6b7280;padding:0 4px}",
    ".hora.erro{color:#b91c1c;cursor:pointer;text-decoration:underline}",
    ".aviso{align-self:center;font-size:12px;color:#92400e;background:#fef3c7;border-radius:8px;padding:6px 10px}",
    ".form{padding:16px 16px 0;display:flex;flex-direction:column;gap:10px;overflow-y:auto;flex:1;background:#f9fafb}",
    ".boas{background:#fff;border:1px solid #e5e7eb;border-radius:16px;border-bottom-left-radius:4px;padding:9px 13px;white-space:pre-wrap}",
    ".campo{display:flex;flex-direction:column;gap:4px}",
    ".campo label{font-size:13px;font-weight:500;color:#374151}",
    ".campo small{font-weight:400;color:#6b7280}",
    ".campo input,.campo textarea,.rodape textarea{font:inherit;font-size:16px;color:#111827;background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:10px 12px;width:100%}",
    ".campo input:focus,.campo textarea:focus,.rodape textarea:focus{outline:2px solid var(--cor);outline-offset:0;border-color:transparent}",
    ".campo textarea{resize:none;min-height:72px}",
    ".campo .erro{font-size:12px;color:#b91c1c}",
    ".botao{border:0;border-radius:10px;padding:12px;font:inherit;font-weight:600;cursor:pointer;background:var(--cor);color:var(--frente)}",
    // Em tela baixa (notebook de 768px com barra de favoritos) o formulário rola —
    // e o botão NÃO pode rolar junto para fora da vista: é a única ação da tela.
    // Gruda no pé, sobre uma faixa da cor do fundo para o texto não vazar por trás.
    ".pe{position:sticky;bottom:0;margin-top:auto;padding:10px 0 16px;background:#f9fafb;display:flex;flex-direction:column}",
    ".botao[disabled],.enviar[disabled]{opacity:.55;cursor:not-allowed}",
    ".rodape{flex:none;display:flex;gap:8px;align-items:flex-end;padding:10px 12px;border-top:1px solid #e5e7eb;background:#fff}",
    ".rodape textarea{resize:none;max-height:112px;min-height:42px}",
    ".enviar{flex:none;width:42px;height:42px;border:0;border-radius:50%;cursor:pointer;background:var(--cor);color:var(--frente);display:flex;align-items:center;justify-content:center}",
    ".enviar svg{width:18px;height:18px}",
    "@media (max-width:480px){",
    ".raiz.aberto{top:0;left:0;right:0;bottom:0}",
    ".raiz.aberto .painel{position:fixed;top:0;left:0;right:0;bottom:0;width:100%;max-width:none;height:100%;max-height:none;border-radius:0}",
    ".raiz.aberto .lancador{display:none}",
    "}",
    "@media (prefers-reduced-motion:reduce){.lancador{transition:none}}",
  ].join("");

  function montar() {
    var hospedeiro = document.createElement("div");
    hospedeiro.setAttribute("data-site-chat", "");
    var sombra = hospedeiro.attachShadow({ mode: "open" });

    var estilo = document.createElement("style");
    estilo.textContent = CSS;
    sombra.appendChild(estilo);

    el.selo = criar("span", { class: "selo", hidden: "", "aria-hidden": "true" });
    el.lancador = criar(
      "button",
      { class: "lancador", type: "button", "aria-label": t.abrir, "aria-expanded": "false", "data-testid": "site-chat-lancador" },
      [svg(ICONE_CHAT), el.selo],
    );

    el.fechar = criar("button", { class: "fechar", type: "button", "aria-label": t.fechar }, [svg(ICONE_FECHAR)]);
    var topo = criar("div", { class: "topo" }, [
      criar("p", { class: "titulo", text: cfg.titulo }),
      cfg.subtitulo ? criar("p", { class: "subtitulo", text: cfg.subtitulo }) : null,
      el.fechar,
    ]);

    el.aviso = criar("div", { class: "aviso", hidden: "", role: "status" });
    el.corpo = criar("div", { class: "corpo", role: "log", "aria-live": "polite", "data-testid": "site-chat-mensagens" }, [el.aviso]);

    el.form = montarFormulario();

    el.texto = criar("textarea", { rows: "1", placeholder: t.mensagem, "aria-label": t.mensagem, maxlength: "4000", "data-testid": "site-chat-texto" });
    el.enviar = criar("button", { class: "enviar", type: "button", "aria-label": t.enviar, "data-testid": "site-chat-enviar" }, [svg(ICONE_ENVIAR)]);
    el.rodape = criar("div", { class: "rodape" }, [el.texto, el.enviar]);

    el.painel = criar(
      "div",
      { class: "painel", role: "dialog", "aria-label": cfg.titulo, hidden: "", "data-testid": "site-chat-painel" },
      [topo, el.form, el.corpo, el.rodape],
    );

    el.raiz = criar("div", { class: "raiz " + (cfg.posicao === "esquerda" ? "esquerda" : "direita") }, [el.painel, el.lancador]);
    el.raiz.style.setProperty("--cor", cfg.cor_principal);
    el.raiz.style.setProperty("--frente", cfg.cor_do_texto);
    sombra.appendChild(el.raiz);

    el.lancador.addEventListener("click", alternar);
    el.fechar.addEventListener("click", fecharPainel);
    el.enviar.addEventListener("click", enviarDoRodape);
    el.texto.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        enviarDoRodape();
      }
    });
    el.texto.addEventListener("input", function () {
      el.texto.style.height = "auto";
      el.texto.style.height = Math.min(el.texto.scrollHeight, 112) + "px";
    });
    sombra.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && aberto) fecharPainel();
    });

    document.body.appendChild(hospedeiro);
    trocarTela();
  }

  function pedeFormulario() {
    var f = cfg.formulario_inicial || {};
    return f.nome !== "oculto" || f.email !== "oculto" || f.telefone !== "oculto";
  }

  function montarCampo(id, rotulo, tipo, modo, extras) {
    if (modo === "oculto") return null;
    var entrada = criar(
      tipo === "textarea" ? "textarea" : "input",
      Object.assign({ id: "sc-" + id, name: id, "data-testid": "site-chat-campo-" + id }, extras || {}),
    );
    if (tipo !== "textarea") entrada.setAttribute("type", tipo);
    if (modo === "obrigatorio") entrada.setAttribute("aria-required", "true");
    var rot = criar("label", { for: "sc-" + id, text: rotulo + " " });
    if (modo === "opcional") rot.appendChild(criar("small", { text: "(" + t.opcional + ")" }));
    var erro = criar("span", { class: "erro", role: "alert" });
    var caixa = criar("div", { class: "campo" }, [rot, entrada, erro]);
    el["campo_" + id] = { entrada: entrada, erro: erro, modo: modo };
    return caixa;
  }

  function montarFormulario() {
    var f = cfg.formulario_inicial || {};
    el.comecar = criar("button", { class: "botao", type: "submit", text: t.comecar, "data-testid": "site-chat-comecar" });
    // Campo-isca: invisível para gente, irresistível para robô que preenche tudo.
    // O `name` é sem sentido de propósito: "website"/"url" são campos que o
    // preenchimento automático do navegador reconhece — e um humano com autofill
    // ligado seria tratado como robô. O nome que o SERVIDOR lê é outro (`website`,
    // no corpo do pedido); este aqui é só o do DOM.
    el.isca = criar("input", { type: "text", name: "sc-conferir", tabindex: "-1", autocomplete: "off", "aria-hidden": "true" });
    el.isca.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;opacity:0";

    var form = criar("form", { class: "form", novalidate: "", hidden: "" }, [
      cfg.mensagem_de_boas_vindas ? criar("div", { class: "boas", text: cfg.mensagem_de_boas_vindas }) : null,
      montarCampo("nome", t.nome, "text", f.nome, { autocomplete: "name", maxlength: "120" }),
      montarCampo("email", t.email, "email", f.email, { autocomplete: "email", maxlength: "254" }),
      montarCampo("telefone", t.telefone, "tel", f.telefone, { autocomplete: "tel", maxlength: "32" }),
      montarCampo("mensagem", t.mensagem.replace("…", ""), "textarea", "obrigatorio", { maxlength: "4000" }),
      el.isca,
      criar("div", { class: "pe" }, [el.comecar]),
    ]);
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      enviarDoFormulario();
    });
    return form;
  }

  /** Formulário enquanto não há conversa; conversa depois. */
  function trocarTela() {
    var noFormulario = !token && pedeFormulario() && mensagens.length === 0;
    el.form.hidden = !noFormulario;
    el.corpo.hidden = noFormulario;
    el.rodape.hidden = noFormulario;
    if (!noFormulario && mensagens.length === 0 && cfg.mensagem_de_boas_vindas && !el.boasNaConversa) {
      el.boasNaConversa = criar("div", { class: "msg deles" }, [
        criar("div", { class: "balao", text: cfg.mensagem_de_boas_vindas }),
      ]);
      el.corpo.appendChild(el.boasNaConversa);
    }
  }

  function alternar() {
    if (aberto) fecharPainel();
    else abrirPainel();
  }

  function marcarComoVisto() {
    if (!cursor || cursor === vistoAte) return;
    vistoAte = cursor;
    gravarGuarda();
  }

  function abrirPainel() {
    aberto = true;
    naoLidas = 0;
    pintarSelo();
    marcarComoVisto();
    el.painel.hidden = false;
    el.raiz.classList.add("aberto");
    el.lancador.setAttribute("aria-expanded", "true");
    el.lancador.setAttribute("aria-label", t.fechar);
    rolarAoFim();
    var foco = !el.form.hidden
      ? (el.campo_nome || el.campo_email || el.campo_telefone || el.campo_mensagem).entrada
      : el.texto;
    // Em telefone o foco automático levanta o teclado e cobre a conversa.
    if (foco && window.matchMedia && !window.matchMedia("(max-width:480px)").matches) foco.focus();
    agendar(0);
  }

  function fecharPainel() {
    aberto = false;
    el.painel.hidden = true;
    el.raiz.classList.remove("aberto");
    el.lancador.setAttribute("aria-expanded", "false");
    el.lancador.setAttribute("aria-label", t.abrir);
    el.lancador.focus();
    agendar();
  }

  function pintarSelo() {
    if (naoLidas > 0) {
      el.selo.hidden = false;
      el.selo.textContent = naoLidas > 9 ? "9+" : String(naoLidas);
      el.lancador.setAttribute("aria-label", t.abrir + " — " + naoLidas + " " + t.novas);
    } else {
      el.selo.hidden = true;
    }
  }

  function rolarAoFim() {
    el.corpo.scrollTop = el.corpo.scrollHeight;
  }

  function hora(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  /** Texto com links clicáveis — montado nó a nó, nunca por `innerHTML`. */
  function preencherTexto(no, textoBruto) {
    var partes = String(textoBruto).split(/(https?:\/\/[^\s<>"']+)/g);
    partes.forEach(function (parte, i) {
      if (i % 2 === 1) {
        var a = criar("a", { href: parte, target: "_blank", rel: "noopener noreferrer nofollow", text: parte });
        no.appendChild(a);
      } else if (parte) {
        no.appendChild(document.createTextNode(parte));
      }
    });
  }

  function urlSegura(u) {
    return typeof u === "string" && /^https:\/\//i.test(u) ? u : typeof u === "string" && /^http:\/\/(localhost|127\.0\.0\.1)/i.test(u) ? u : null;
  }

  function desenhar(m) {
    var balao = criar("div", { class: "balao" });
    var midia = m.media && urlSegura(m.media.url);
    if (midia && m.type === "image") {
      balao.appendChild(criar("img", { src: midia, alt: m.body || "", loading: "lazy" }));
    } else if (midia && m.type === "audio") {
      balao.appendChild(criar("audio", { src: midia, controls: "", preload: "none" }));
    } else if (midia && m.type === "video") {
      balao.appendChild(criar("video", { src: midia, controls: "", preload: "metadata" }));
    } else if (midia) {
      balao.appendChild(
        criar("a", { href: midia, target: "_blank", rel: "noopener noreferrer", text: (m.media && m.media.filename) || t.arquivo }),
      );
    }
    if (m.body) {
      var txt = criar("div");
      preencherTexto(txt, m.body);
      balao.appendChild(txt);
    }

    var rodape = criar("span", { class: "hora" });
    var no = criar("div", { class: "msg " + (m.direction === "inbound" ? "minha" : "deles") }, [balao, rodape]);
    no.setAttribute("data-testid", m.direction === "inbound" ? "site-chat-msg-visitante" : "site-chat-msg-atendente");
    m.no = no;
    m.rodape = rodape;
    pintarEstado(m);
    el.corpo.appendChild(no);
  }

  function pintarEstado(m) {
    if (!m.rodape) return;
    m.rodape.className = "hora";
    m.rodape.onclick = null;
    if (m.estado === "enviando") m.rodape.textContent = t.enviando;
    else if (m.estado === "falhou") {
      m.rodape.className = "hora erro";
      m.rodape.textContent = t.falhou;
      m.rodape.setAttribute("role", "button");
      m.rodape.onclick = function () {
        postar(m);
      };
    } else m.rodape.textContent = hora(m.at);
  }

  /** Entra uma mensagem vinda do servidor. Devolve `true` se era nova na tela. */
  function receber(dto) {
    if (!dto || !dto.id || vistos[dto.id]) return false;
    vistos[dto.id] = true;
    if (!cursor || dto.created_at > cursor) cursor = dto.created_at;

    // A cópia otimista da MINHA mensagem já está na tela: só ganha o id.
    if (dto.client_id) {
      for (var i = 0; i < mensagens.length; i++) {
        if (mensagens[i].clientId === dto.client_id) {
          mensagens[i].id = dto.id;
          mensagens[i].at = dto.created_at;
          mensagens[i].estado = "ok";
          pintarEstado(mensagens[i]);
          return false;
        }
      }
    }

    var m = {
      id: dto.id,
      clientId: dto.client_id || null,
      direction: dto.direction,
      type: dto.type,
      body: dto.body,
      media: dto.media || null,
      at: dto.created_at,
      estado: "ok",
    };
    mensagens.push(m);
    desenhar(m);
    return true;
  }

  function avisar(textoDoAviso) {
    if (!textoDoAviso) {
      el.aviso.hidden = true;
      return;
    }
    el.aviso.textContent = textoDoAviso;
    el.aviso.hidden = false;
  }

  // ── Envio ─────────────────────────────────────────────────────────────────

  function paginaAtual() {
    var utm = {};
    try {
      new URLSearchParams(window.location.search).forEach(function (valor, nome) {
        if (/^utm_[a-z_]{1,20}$/.test(nome)) utm[nome] = String(valor).slice(0, 120);
      });
    } catch (e) {
      /* sem URLSearchParams: segue sem utm */
    }
    return {
      // Só origem + caminho: a query de um site alheio pode carregar token de
      // sessão, e-mail ou id de pedido que não é nosso para guardar.
      url: (window.location.origin + window.location.pathname).slice(0, 500),
      titulo: String(document.title || "").slice(0, 200),
      utm: utm,
    };
  }

  function postar(m) {
    if (enviando) return;
    enviando = true;
    m.estado = "enviando";
    pintarEstado(m);
    el.enviar.disabled = true;
    if (el.comecar) el.comecar.disabled = true;

    var corpo = { body: m.body, client_message_id: m.clientId, pagina: paginaAtual() };
    // Os dados do formulário moram NA mensagem: o "toque para tentar de novo" da
    // primeira mensagem precisa levá-los junto, senão o contato nasce sem nome.
    // Com token a conversa já existe e o servidor os ignoraria de qualquer jeito.
    if (m.visitante && !token) corpo.visitante = m.visitante;
    if (el.isca && el.isca.value) corpo.website = el.isca.value;

    pedir("POST", "/messages", corpo)
      .then(function (r) {
        if (r.status === 401 && token) {
          // A conversa foi apagada do lado de lá (anonimização, canal recriado).
          // Recomeça como visitante novo em vez de repetir um token morto.
          token = null;
          gravarGuarda();
          enviando = false;
          return postar(m);
        }
        if (!r.ok || !r.json || !r.json.data) {
          m.estado = "falhou";
          pintarEstado(m);
          avisar(r.status === 429 ? t.muitoRapido : null);
          return;
        }
        avisar(null);
        var d = r.json.data;
        if (d.visitor_token) {
          token = d.visitor_token;
          gravarGuarda();
        }
        if (d.message) {
          vistos[d.message.id] = true;
          m.id = d.message.id;
          m.at = d.message.created_at;
          if (!cursor || d.message.created_at > cursor) cursor = d.message.created_at;
        }
        m.estado = "ok";
        pintarEstado(m);
        trocarTela();
        marcarComoVisto();
        agendar(1500);
      })
      .catch(function () {
        m.estado = "falhou";
        pintarEstado(m);
        avisar(t.semConexao);
      })
      .then(function () {
        enviando = false;
        el.enviar.disabled = false;
        if (el.comecar) el.comecar.disabled = false;
      });
  }

  function novaMensagemMinha(textoDaMensagem) {
    var m = {
      id: null,
      clientId: uuid(),
      direction: "inbound",
      type: "text",
      body: textoDaMensagem,
      media: null,
      at: new Date().toISOString(),
      estado: "enviando",
    };
    mensagens.push(m);
    return m;
  }

  function enviarDoRodape() {
    var valor = el.texto.value.trim();
    if (!valor || enviando) return;
    el.texto.value = "";
    el.texto.style.height = "auto";
    var m = novaMensagemMinha(valor);
    desenhar(m);
    rolarAoFim();
    postar(m);
  }

  function validarCampo(campo, valido, mensagemDeErro) {
    if (!campo) return true;
    var valor = campo.entrada.value.trim();
    var erro = "";
    if (!valor && campo.modo === "obrigatorio") erro = t.obrigatorio;
    else if (valor && valido && !valido(valor)) erro = mensagemDeErro;
    campo.erro.textContent = erro;
    campo.entrada.setAttribute("aria-invalid", erro ? "true" : "false");
    return !erro;
  }

  function enviarDoFormulario() {
    if (enviando) return;
    var ok = [
      validarCampo(el.campo_nome),
      validarCampo(el.campo_email, function (v) {
        return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
      }, t.emailInvalido),
      validarCampo(el.campo_telefone, function (v) {
        var digitos = v.replace(/\D/g, "");
        return digitos.length >= 10 && digitos.length <= 15;
      }, t.telefoneInvalido),
      validarCampo(el.campo_mensagem),
    ].every(Boolean);
    if (!ok) {
      var primeiro = el.form.querySelector('[aria-invalid="true"]');
      if (primeiro) primeiro.focus();
      return;
    }

    var visitante = {};
    if (el.campo_nome && el.campo_nome.entrada.value.trim()) visitante.nome = el.campo_nome.entrada.value.trim();
    if (el.campo_email && el.campo_email.entrada.value.trim()) visitante.email = el.campo_email.entrada.value.trim();
    if (el.campo_telefone && el.campo_telefone.entrada.value.trim()) visitante.telefone = el.campo_telefone.entrada.value.trim();

    var m = novaMensagemMinha(el.campo_mensagem.entrada.value.trim());
    // Sai do formulário JÁ: a pessoa vê a própria mensagem indo, em vez de um
    // botão travado. Se falhar, o "toque para tentar de novo" carrega os dados.
    el.form.hidden = true;
    el.corpo.hidden = false;
    el.rodape.hidden = false;
    if (cfg.mensagem_de_boas_vindas && !el.boasNaConversa) {
      el.boasNaConversa = criar("div", { class: "msg deles" }, [criar("div", { class: "balao", text: cfg.mensagem_de_boas_vindas })]);
      el.corpo.appendChild(el.boasNaConversa);
    }
    m.visitante = visitante;
    desenhar(m);
    rolarAoFim();
    postar(m);
  }

  // ── Sondagem ──────────────────────────────────────────────────────────────

  function agendar(emMs) {
    if (relogio) window.clearTimeout(relogio);
    if (!token) return;
    var intervalo = emMs !== undefined ? emMs : aberto ? 3000 : 15000;
    // Falha seguida recua até 30s: um CRM fora do ar não pode virar martelada
    // vinda de todos os visitantes de todos os sites ao mesmo tempo.
    if (falhasSeguidas > 0 && emMs === undefined) intervalo = Math.min(30000, intervalo * Math.pow(2, falhasSeguidas));
    relogio = window.setTimeout(sondar, intervalo);
  }

  function sondar() {
    if (!token) return;
    if (document.hidden) return agendar();
    var caminho = "/messages" + (cursor ? "?after=" + encodeURIComponent(cursor) : "");
    pedir("GET", caminho)
      .then(function (r) {
        if (r.status === 401) {
          token = null;
          gravarGuarda();
          return;
        }
        if (!r.ok || !r.json || !Array.isArray(r.json.data)) {
          falhasSeguidas++;
          return;
        }
        falhasSeguidas = 0;
        avisar(null);
        var colado = el.corpo.scrollHeight - el.corpo.scrollTop - el.corpo.clientHeight < 60;
        var novasDeles = 0;
        var naoVistas = 0;
        r.json.data.forEach(function (dto) {
          if (!receber(dto) || dto.direction !== "outbound") return;
          novasDeles++;
          // "Não lida" é o que chegou DEPOIS do que ele já viu — não o que esta
          // página ainda não tinha desenhado.
          if (!vistoAte || dto.created_at > vistoAte) naoVistas++;
        });
        if (novasDeles > 0) {
          trocarTela();
          if (aberto) {
            if (colado) rolarAoFim();
            marcarComoVisto();
          } else if (naoVistas > 0) {
            naoLidas += naoVistas;
            pintarSelo();
          }
        }
      })
      .catch(function () {
        falhasSeguidas++;
      })
      .then(function () {
        agendar();
      });
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && cfg) agendar(0);
  });

  // ── Partida ───────────────────────────────────────────────────────────────

  function partir() {
    var guardado = lerGuarda();
    token = guardado ? guardado.t : null;
    vistoAte = guardado && typeof guardado.v === "string" ? guardado.v : null;

    pedir("GET", "/config")
      .then(function (r) {
        if (!r.ok || !r.json || !r.json.data) {
          // 403 = este domínio não está na lista do dono; 404 = canal removido.
          // Nos dois casos o site do cliente segue intacto, só sem o balão.
          if (r.status === 403) console.warn("[site-chat] este domínio não está autorizado para este widget.");
          return;
        }
        cfg = r.json.data;
        t = TEXTOS[cfg.idioma] || TEXTOS.pt;
        montar();
        if (token) sondar();
      })
      .catch(function () {
        /* CRM inalcançável: o site do cliente não deve nem notar. */
      });
  }

  window.SiteChat = {
    open: function () {
      if (cfg && !aberto) abrirPainel();
    },
    close: function () {
      if (cfg && aberto) fecharPainel();
    },
  };

  if (document.body) partir();
  else document.addEventListener("DOMContentLoaded", partir);
})();
