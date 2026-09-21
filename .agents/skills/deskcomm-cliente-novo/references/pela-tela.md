# Tela a tela — a ordem que o sistema impõe, os campos e o que cada um faz

Os rótulos abaixo foram conferidos na tela da v1.34.0 (Times, Conectores e Etapas do funil
conferidos numa implantação real em 21/09/2026). Cada peça exige a anterior: o
schema recusa publicar agente sem número conectado e sem credencial validada; fluxo só roda
publicado; material só vale com indexação pronta.

## 1. Conexões — o número (pré-requisito de tudo)

O onboarding conecta por QR. Para conferir: **Conexões** → o número aparece com status *WORKING*.
Proteção de envio (janela, ritmo, aquecimento) fica no próprio número.

**Modo de teste do canal.** Canal criado pelo produto nasce em modo de teste: a IA só responde aos
números da lista de teste daquele canal — com a lista vazia, não responde a ninguém. É isso que
permite publicar o agente num número que também é usado por gente (o celular do dono, com
conversas pessoais) sem a IA assumir essas conversas. Antes de publicar, pergunte **de que número a
pessoa vai testar** e ponha-o na lista (com DDI, ex.: +5561999998888); abrir para todos é uma decisão
dela, depois dos testes. Para conferir sem abrir a tela:
`select provider, metadata->>'ai_gate_mode', metadata->'ai_test_phone_numbers' from channel_sessions where archived_at is null;`

## 1b. Configurações › Times de atendimento — os setores

Quando a IA passa a conversa para uma pessoa, ela escolhe **para qual setor**. Cada time tem:
**Nome do time**; **Identificador** (gerado do nome — é por ele que o agente chama o time);
**Limite de conversas simultâneas por atendente** (vazio = sem limite; todos no limite, a conversa
espera na fila do time); **Quando usar** (o agente lê isto para escolher — escreva os assuntos como
o cliente fala: "fatura, boleto, internet bloqueada por atraso"); **Horário de atendimento** (uma
janela por dia da semana, com fuso; sem janela = atende a qualquer hora; fora do horário a conversa
espera na fila do time); **Quem atende por este time** (só quem já está na Equipe).

O agente descobre os times sozinho, no atendimento — **o prompt não nomeia time**: renomear um time
não pode quebrar prompt nenhum. O prompt diz *quando* passar e pede para escolher o setor; o
"quando usar" diz *qual*. Para o agente enxergar os setores, ligue o pacote **Passar para um
humano** nas capacidades (§7). A transferência pelas **palavras de passagem** (§7) roda antes do
modelo e **não escolhe setor**: cai na fila geral.

## 1c. Configurações › Conectores — o sistema que a empresa já usa (ex.: IXC)

Liga um ERP à organização: endereço do sistema e um token **só de leitura e dedicado** (peça ao
responsável pelo ERP; nunca digite credencial por ele). Salvar **testa** antes de gravar; falha
aparece na própria tela. Com o conector ativo, a conversa ganha uma aba do sistema no painel direito
(para o IXC: cliente, bloqueio, contrato, faturas, OS, conexão e sinal) e o atendente envia a fatura
por um botão. **O que o agente de IA enxerga do ERP depende da versão**: abra a aba **Capacidades**
do agente e procure o nome do sistema — se não houver capacidade com ele, a IA ainda não consulta o
ERP, e o prompt deve mandar o assunto (fatura, bloqueio) para o setor humano que usa a aba.

## 2. IA › Credenciais

**Adicionar** → provedor (Anthropic, OpenAI, Google, OpenRouter), um nome ("Chave principal") e a
chave. A validação roda em segundo plano contra o provedor; só credencial **validada** publica um
agente. Sem credencial, o agente pode usar a chave da instalação (a do `.env`) para Anthropic,
OpenAI e OpenRouter — Google só funciona como credencial daqui. A chave da OpenAI para áudio e
base de conhecimento entra aqui também.

## 3. IA › Provedores

Um modelo por **ponto de uso**: atendimento (precisa usar ferramentas), roteador (classificador —
um modelo barato basta), follow-up, transcrição de áudio, embeddings (fixo: `text-embedding-3-small`
da OpenAI). "Automático" usa o provedor padrão da organização. É aqui que se troca de provedor
depois da instalação.

## 4. Funil — CRM › Funis e Configurações › Etapas do funil

**CRM › Funis** lista, cria (**Novo funil** — nasce com Novo, Em andamento, Ganho, Perdido),
renomeia, arquiva e **Tornar padrão**. O padrão é onde **toda conversa nova nasce** como oportunidade
— a do onboarding é um funil de loja; troque. O funil **não é apagado** ao deixar de ser padrão, e
os cards que já estavam nele ficam lá: arquivar é decisão da pessoa.

**Etapas do funil** (`/app/settings/tenant/pipelines`), por funil:
- **Etapas deste funil**: clique no nome para renomear; setas movem a coluna; **Acrescentar etapa
  ao fim**; o papel de cada coluna — *Nada especial*, *Aqui o cliente fecha* (ganhou) ou *Aqui o
  cliente desiste* (perdeu). Cada funil tem exatamente uma de cada: marcar uma nova **desmarca** a
  anterior (pede confirmação). Atalho: renomeie as 4 etapas iniciais para as primeiras do pacote,
  acrescente o resto e mude os papéis — evita reordenar coluna por coluna.
- **Para onde o card vai em cada passo**: os 7 passos do agente (Novo lead, Primeiro contato, Em
  qualificação, Qualificado, Em negociação, Ganho, Perdido) → a etapa, ou **Não mover o card**.
  Passo sem etapa é escolha válida. Onde o mesmo número atende venda **e** suporte, deixe *Primeiro
  contato* em "não mover": o agente marca esse passo na primeira resposta de qualquer conversa.
  **Salvar estas escolhas.**
- **Vocabulário e campos**: Lead, Deal, Won, Lost (singular — o plural não tem campo na tela),
  motivos de perda separados por vírgula, campos do lead. **Salvar vocabulário e campos.**

Separar quem **já é cliente** num funil próprio ("funil de clientes") só acontece sozinho com a regra
**Clientes pela agenda** (Configurações › Tipos de agendamento) — cliente é quem teve horário
marcado. Negócio sem agenda (provedor, loja) não tem esse sinal: o cliente antigo nasce no funil
padrão.

## 5. IA › Conhecimento ("O que o agente sabe")

**Adicionar material** → tipo: *FAQ* (pares pergunta/resposta — cole em markdown com
`## Pergunta:` / `## Resposta:` ou preencha os pares), *documento* (PDF, MD ou TXT até 20 MB; ou
texto colado), *catálogo* (vem da loja integrada) e *conversas* (aprendizado automático). Nome
único por material. A indexação é assíncrona: o material aparece como "pronto" quando indexado;
sem chave da OpenAI ele fica sem indexar e a tela avisa. Materiais são da organização; cada agente
escolhe quais usa.

## 6. IA › Follow-ups ("Fluxos")

**Novo fluxo** → nome (único). No editor: **gatilho** (manual; silêncio por N minutos; mudança de
etapa; falta a compromisso; caso aberto; webhook) com *cancelar quando responder*; depois os nós:
**espera** (fixa, de 5 min a 90 dias, ou inteligente com mínimo/máximo), **mensagem** (texto,
gerada pela IA com uma orientação, ou modelo de mensagem), **condição** (etapa, tag, passos dados,
último desfecho), **classificar resposta** (até 8 classes, com carência mínima de 15 min), **fim**
(convertido, esgotado, personalizado). Política ao passar para humano: pausar, cancelar ou seguir.
**Publicar** valida o grafo (gatilho presente, nada inalcançável, caminho de fallback, ciclos só com
espera). Rascunho não roda.

## 7. IA › Agentes

**Novo agente** → aba **Configuração**: nome, descrição, prioridade (desempata quando dois agentes
publicados atendem o mesmo número); o **prompt**; provedor, modelo e credencial (ou "chave desta
instalação"); o **número** que atende; **funis** em que pode mover leads (nenhum = só conversa);
**materiais** que consulta; **follow-ups** que arma; palavras de passagem para humano (padrão:
"falar com humano", "atendente", "pessoa real"); casos (abrir demanda para o time); dividir
mensagens longas; horário de atendimento (fora dele, adia). Aba **Capacidades**: os pacotes
(*vender* já traz agenda, catálogo, conhecimento, notas e funil) e as capacidades **críticas**
uma a uma (enviar mensagem avulsa, cancelar agenda, fechar caso) — o teto é 25.

Salvar cria a **versão 1 em rascunho**. Mudou algo depois de publicado? É versão nova — versão
publicada é imutável, e **Reverter** cria outra a partir da anterior.

O que a tela esconde e custa caro descobrir:
- **Capacidades são por pacote**, não uma a uma (há um "modo avançado"). O teto é 25 e os pacotes
  se sobrepõem: *Atender* (18) + *Vender* (21) + *Passar para um humano* (13) passam do teto. Um
  agente que não agenda nem vende catálogo precisa só de **Passar para um humano** (é o que traz a
  lista de setores) — mover no funil, anotar, consultar a base e responder já são do próprio motor.
- **Materiais** e **funis** que o agente usa aparecem só depois de criados: se a tela de agente
  foi aberta antes, ela mostra "nenhum material"/"nenhum funil" — salve o rascunho e recarregue.
  Os funis ficam na aba **Organiza o sistema** ("Em que negócios ele pode mexer").
- **Palavras de passagem** casam em qualquer ponto da mensagem: a palavra solta "atendente" dispara
  em "o atendente não resolveu". Prefira frases ("quero falar com atendente").
- **Responder em várias mensagens curtas**: rode o Testar com ele ligado e leia a ordem das
  mensagens. Se a saudação vier depois da pergunta, desligue — o modelo disparou várias mensagens
  ao mesmo tempo e elas saíram na ordem em que terminaram, não na em que foram escritas.
- **Operação do agente** (topo da página): *Automático* responde sozinho; *Assistido* só prepara a
  sugestão na conversa e o envio depende de um humano aprovar.

## 8. Testar (na versão, antes de publicar)

Aba de teste da versão: uma mensagem, um contato fictício. Volta o texto que o agente mandaria,
as ações que tentaria (oferecer horário, registrar, mover) e os portões que passaram ou vetaram.
Consome crédito da IA. Sem histórico nem memória do lead — é o teste da primeira mensagem.

Leia **Ações propostas**, não só o texto: uma transferência aparece como ação, e é nela que se vê se o
agente escolheu setor. Os detalhes (setor escolhido, passo do funil) ficam em
`select tool_calls from ai_agent_runs where agent_id = '<id>' order by created_at desc limit 1;`
— o texto "vou te passar para o time X" não prova que a ação levou o setor X.

## 9. Publicar

Botão **Publicar** com confirmação. O sistema recusa com motivo claro quando falta credencial
validada, o número não está WORKING, o modelo saiu do catálogo ou uma capacidade não existe. A
publicação vale no próximo atendimento, sem reiniciar nada.

## 10. IA › Roteadores (só com dois ou mais agentes no mesmo número)

**Novo roteador** → nome, **Número de WhatsApp** (só um roteador ativo por número). Depois,
**Intenções**: para cada uma, **Nome da intenção** ("quer agendar"), **Agente que atende**,
**Quando escolher esta intenção** (a descrição é o que o classificador lê — escreva como o cliente
fala) e **Frases de exemplo**. **Agente de fallback** para quando nenhuma casa; **Modelo do
classificador** ("Automático" usa o provedor da organização). Ative. Roteador sem intenções e sem
fallback não sequestra o número; membro sem versão publicada cai no fallback.

## 11. IA › Memória

**Documento da organização**: as regras da casa em texto corrido — **Publicar versão** (vale para
todos os agentes no próximo atendimento; só admin publica). **Aprendizados**: itens curtos com
**Título** e **O que o agente deve saber**; os "aprendidos automaticamente" vêm das propostas de
melhoria e ficam para revisar.

## 12. IA › Skills

As duas da plataforma (`agendamento`, `objecao-preco`) já valem para todo agente. **Instalar** cria
uma cópia da organização para personalizar; **Importar** aceita um `.zip` com `SKILL.md` (nome,
descrição, palavras-chave que ativam) — é um roteiro condicional de texto, não um programa.

## 13. Depois

Configurações › Webhooks e automações (formulário do site → funil → mensagem da IA); Equipe
(convites, papéis, distribuição manual ou rodízio); Uso e orçamento (teto mensal de IA). Tokens de
API só se um sistema externo for falar com o CRM pelo MCP.
