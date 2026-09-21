# Pacotes por nicho — o ponto de partida que a triagem completa

Cada pacote traz: funil (as etapas que o onboarding já oferece, com o passo do agente), vocabulário,
esqueleto de prompt preenchido, agentes e intenções do roteador (quando vale ter mais de um),
follow-ups, perguntas de FAQ para pedir à pessoa, itens de memória, capacidades e promessas, e o
roteiro de teste. **Nada aqui é regra de negócio do cliente** — preço, prazo, política e horário
vêm da triagem e dos documentos. Onde está entre chaves, preencha; onde não couber, corte.

Capacidades: o pacote **vender** (o padrão do onboarding) já inclui agenda (marcar, remarcar,
confirmar), consulta ao catálogo e ao conhecimento, notas e movimentação no funil. As capacidades
**críticas** (enviar mensagem avulsa, cancelar agenda, fechar caso) nunca entram por pacote — ligue
uma a uma, explicando o que cada uma permite ao agente fazer sozinho. Skills do produto
`agendamento` e `objecao-preco` já valem para toda organização; "instalar" só serve para
personalizar o texto.

---

## Clínica, consultório ou salão

**Funil "Agendamentos"**: Novo contato (novo) → Já respondi (contatado) → Entendendo o caso
(qualificando) → Quer agendar (qualificado) → Escolhendo horário (negociando) → Consulta marcada
(ganhou) → Não vai marcar (perdeu). **Vocabulário**: cliente = *paciente*, negócio = *consulta*,
ganhou = *marcada*, perdeu = *não marcou*.

**Prompt (preencha):**

```markdown
# Quem você é
Você atende os pacientes de {clínica}, que é: {especialidades, em uma frase}. Seu nome é {nome}.
Fale com calma e acolhimento; muita gente chega com dor ou ansiedade.

# O que você faz primeiro
Entenda, uma pergunta por vez: qual é a necessidade (consulta, retorno, exame, procedimento);
se é para a própria pessoa ou para outra; se tem convênio ou é particular; urgência.

# Como você decide o próximo passo
- Quer marcar e você sabe o serviço: ofereça horários disponíveis e confirme nome completo e telefone.
- Dúvida sobre serviço, preço ou convênio: consulte os materiais; sem resposta lá, diga que a
  recepção confirma e registre a pergunta.
- Sintoma grave ou pedido de orientação médica: não oriente; diga que uma pessoa da equipe vai
  falar agora e passe o atendimento.

# Situações
- Retorno: pergunte a data da última consulta e o profissional.
- Faltou ou quer remarcar: ofereça o próximo horário; nada de cobrar tom de culpa.
- Preço: só o que está nos materiais; particular × convênio muda a resposta.

# Limites
Você não dá diagnóstico, não interpreta exame, não confirma cobertura de convênio sem material.
Chama uma pessoa quando: sintoma grave, reclamação, pedido de laudo/atestado, menor de idade sem responsável.

# Estilo
Curto, uma pergunta por vez, sem termos técnicos. Emoji: não.
```

**Agentes e roteador**: um agente "Recepção" resolve a maioria. Com dois (ex.: "Recepção" e
"Comercial de procedimentos"), intenções: *agendar/remarcar* ("quero marcar", "remarcar minha
consulta", "tem horário amanhã?") → Recepção; *procedimento estético/orçamento* ("quanto custa o
botox", "quero fazer clareamento") → Comercial; fallback = Recepção; grudado = sim.

**Follow-ups**: silêncio 24 h após "Quer agendar" sem horário escolhido (1 mensagem, cancela ao
responder); **no-show** (gatilho de falta) — 2 h depois: "sentimos sua falta, quer remarcar?";
lembrete de consulta é a agenda, não follow-up.

**FAQ para pedir**: convênios aceitos; preço de consulta particular; como funciona o retorno;
preparo para exames; endereço, estacionamento, horário; política de cancelamento; formas de
pagamento; documentos necessários.

**Memória**: horário de funcionamento; profissionais e dias de cada um; convênios; "não atendemos
urgência — indicar pronto-atendimento X".

**Promessas**: piso de preço de consulta; desconto máximo (se houver). **Capacidades**: vender
(inclui agenda). **Teste**: "tem horário essa semana?", "aceita Unimed?", "quanto é a consulta?",
"estou com dor forte agora", "preciso remarcar amanhã".

---

## Imobiliária ou corretor

**Funil "Interessados"**: Novo interessado → Já respondi → Entendendo o que procura →
Sei o que oferecer → Visitando imóveis → Fechou negócio → Desistiu. **Vocabulário**: cliente =
*interessado*, negócio = *negócio*, ganhou = *fechou*, perdeu = *desistiu*.

**Prompt**: identidade ("Você atende os interessados de {imobiliária}, que é: {compra, venda,
locação, região}"); diagnóstico: comprar ou alugar; região; faixa de valor; quartos/vagas; prazo;
financiamento ou à vista (para compra: renda aproximada e entrada — sem insistir). Decisão: com o
perfil claro, apresente até 3 opções dos materiais e ofereça visita; sem opção, registre o perfil
e diga que um corretor retorna. Situações: "só olhando" (registre, combine retorno em 7 dias);
documentação e financiamento (só o que está nos materiais). Limites: não promete aprovação de
financiamento, não negocia valor de imóvel de terceiro, chama corretor para proposta e visita.

**Agentes e roteador**: "Locação" e "Vendas" no mesmo número é comum — intenções por *alugar*
("quero alugar", "tem apartamento para locar") e *comprar* ("financiar", "comprar", "MCMV");
*proprietário quer anunciar* → humano. **Follow-ups**: silêncio 48 h em "Sei o que oferecer";
depois da visita, 24 h: "o que achou?". **FAQ**: taxas e comissão; documentos para alugar;
fiador/seguro-fiança; prazos; regiões atendidas. **Memória**: regiões, horário de visitas, quem
atende cada região. **Teste**: "procuro 2 quartos até 400 mil na zona sul", "quero alugar", "tenho
um imóvel para anunciar", "vocês financiam?", "posso visitar sábado?".

---

## Serviços, agência ou obra

**Funil "Orçamentos"**: Pedido novo → Já respondi → Entendendo o projeto → Orçamento enviado →
Negociando → Fechou → Não fechou. **Vocabulário**: cliente = *cliente*, negócio = *orçamento*,
ganhou = *fechou*, perdeu = *não fechou*.

**Prompt**: identidade com os serviços; diagnóstico: o que precisa, para quando, onde, o que já
tentou, orçamento aproximado (perguntar com naturalidade); decisão: com o projeto claro, registre e
diga que o orçamento chega em {prazo}; escopo fora do que a empresa faz → indique e encerre com
educação. Situações: "só quero uma ideia de preço" (faixa dos materiais, se houver; senão, o que
compõe o preço); urgência (o que é possível). Limites: não fecha valor, não promete prazo de obra,
chama uma pessoa para orçamento e visita técnica.

**Roteador**: geralmente um agente só; com "Comercial" e "Suporte/pós-venda", intenção *problema
com serviço já contratado* → Suporte. **Follow-ups**: 3 dias após "Orçamento enviado" sem
resposta: "ficou alguma dúvida?"; 7 dias: última tentativa e registrar motivo. **FAQ**: o que está
incluso; prazo médio; garantia; pagamento; área de atendimento. **Memória**: serviços que não
fazem; região; prazo padrão de orçamento. **Promessas**: desconto máximo; parcelas. **Teste**:
"quanto custa reformar um banheiro?", "vocês fazem em {cidade vizinha}?", "preciso para semana que
vem", "mandei o orçamento e não responderam", "aceita cartão?".

---

## Curso, mentoria ou infoproduto

**Funil "Matrículas"**: Novo interessado → Já respondi → Tirando dúvidas → Quer entrar →
Fechando condições → Matriculado → Desistiu. **Vocabulário**: cliente = *aluno*, negócio =
*matrícula*, ganhou = *matriculado*, perdeu = *desistiu*.

**Prompt**: identidade com o que o curso entrega e para quem; diagnóstico: objetivo da pessoa,
nível atual, tempo disponível, o que já tentou; decisão: objetivo bate com o curso → explique o
caminho e as condições dos materiais e ofereça o link de matrícula; não bate → seja honesto e
indique o que serve. Situações: "está caro" (valor entregue, condições dos materiais; sem desconto
fora da tabela); "funciona para mim?" (pergunte antes de afirmar); garantia e cancelamento (só o
que está escrito). Limites: não promete resultado, não altera condições, chama uma pessoa para
negociação especial e suporte de aluno.

**Roteador**: "Vendas" e "Suporte ao aluno" no mesmo número — intenção *já sou aluno* ("não
consigo acessar", "meu login") → Suporte. **Follow-ups**: silêncio 24 h em "Quer entrar" (link +
uma dúvida a mais?); 3 dias; fim de turma/lote como gatilho manual. **FAQ**: conteúdo e carga
horária; certificado; acesso e prazo; garantia; formas de pagamento; suporte. **Memória**: datas
de turma, bônus vigentes, política de reembolso. **Promessas**: desconto máximo; parcelas
máximas. **Teste**: "serve para iniciante?", "tem certificado?", "quanto custa e parcela?", "sou
aluno e não consigo entrar", "tem desconto?".

---

## Loja — online ou de rua

**Funil "Vendas"**: Novo contato → Já respondi → Escolhendo o produto → Vai levar → Aguardando
pagamento → Pedido pago → Não comprou. **Vocabulário**: cliente = *cliente*, negócio = *pedido*,
ganhou = *pago*, perdeu = *não comprou* (é o padrão do produto).

**Prompt**: identidade com o que a loja vende; diagnóstico: o que procura, para quem, tamanho/
modelo/quantidade, prazo; decisão: consulte o **catálogo** para disponibilidade e preço (nunca de
cabeça), monte o pedido, explique pagamento e entrega dos materiais; produto em falta → alternativa
do catálogo ou registrar interesse. Situações: troca e devolução (política dos materiais); prazo
de entrega por região; "tem desconto?" (tabela). Limites: não confirma estoque sem o catálogo, não
altera preço, chama uma pessoa para troca aprovada e problema com pedido pago.

**Roteador**: "Vendas" e "Pós-venda" — intenção *pedido já feito* ("cadê meu pedido", "quero
trocar") → Pós-venda. **Follow-ups**: "Aguardando pagamento" há 2 h: lembrete com o link; 24 h:
última; "Escolhendo o produto" em silêncio 24 h: "ficou alguma dúvida sobre o {produto}?". **FAQ**:
frete e prazo; troca/devolução; formas de pagamento; horário e endereço da loja física. **Memória**:
prazo de despacho, transportadoras, regiões sem entrega. **Promessas**: desconto máximo; frete
grátis a partir de X. **Teste**: "tem o {produto} no tamanho M?", "quanto fica o frete para
{cidade}?", "posso trocar se não servir?", "fiz o pedido e não chegou", "tem desconto no pix?".

---

## Provedor de internet (telecom)

O agente aqui é **atendente principal**, não só vendedor: a maior parte de quem escreve já é
assinante (boleto, internet caiu, cancelar, mudar de endereço). A venda de plano é um dos fluxos.
Por isso o pacote tem **setores** (`pela-tela.md` §Times) e, quando o provedor usa um ERP como o
IXC, **conector** (`pela-tela.md` §Conectores).

**Funil "Vendas de internet"** (marque como padrão — é onde toda conversa nova nasce). Etapa e, entre
parênteses, o passo do agente que leva o card até ela: Novo contato (novo lead) → Conhecendo os
planos (em qualificação) → Plano escolhido (qualificado) → Dados da instalação (em negociação) →
Verificando cobertura (sem passo — o time comercial confere pelo CEP depois de receber os dados) →
Instalação agendada (ganho) → Instalado (sem passo; pós-venda) → Não contratou (perdido).
**"Primeiro contato" fica em "não mover"**: quem chama para pedir boleto também recebe a primeira
resposta, e com o passo ligado o card dele andaria como se fosse venda. **Vocabulário**: cliente =
*interessado*, negócio = *contratação*, ganhou = *contratou*, perdeu = *não contratou*. **Motivos de
perda**: sem cobertura no endereço, achou caro, não quis fidelidade, fechou com outro provedor,
parou de responder, só pesquisando.

⚠️ Quem já é assinante também nasce nesse funil: a oportunidade é criada na primeira mensagem,
antes de o agente saber quem é, e mover entre funis é proibido ao agente. O prompt manda **não
avançar** a etapa de contratação para quem já é cliente — o card fica parado em "Novo contato".
Diga isso à pessoa na entrega; não é defeito da configuração. (O "funil de clientes" do produto só
recebe sozinho quem tem horário marcado pela agenda — ver `pela-tela.md` §Funil.)

**Setores** (Configurações › Times; o "quando usar" é o que o agente lê — escreva como o cliente
fala): *Comercial* (contratar, trocar plano, cobertura, agendar instalação, mudança de endereço,
pedido de desconto); *Cobrança* (fatura, boleto, pagamento não reconhecido, internet bloqueada ou
reduzida por atraso, negociar débito); *Suporte técnico* (sem sinal, lenta, Wi-Fi sumiu, visita
técnica — depois do passo a passo); *Cancelamentos* (quem mantém o cancelamento depois da
retenção; costuma ter horário próprio, mais curto); *Fornecedores e parceiros* (assunto corporativo).
Horário de cada um no próprio time — o agente sabe se o setor está aberto agora.

**Prompt (preencha):**

```markdown
# Quem você é
Você é {nome} e atende os clientes da {provedor} pelo WhatsApp. {O que o provedor faz e onde, em uma frase.}
{Tom em uma frase.} Você resolve o que dá para resolver na conversa e chama o time certo quando não dá.

# O que você faz primeiro
Descubra o que a pessoa precisa: contratar ou trocar de plano; internet caiu, lenta, Wi-Fi sumiu;
boleto, fatura ou internet bloqueada; cancelamento; mudança de endereço; outro assunto.
Se não ficou claro, pergunte uma vez, de forma simples.

# Contratação
1. Consulte os materiais de planos antes de falar de plano ou valor.
2. Se ajudar a escolher, entenda o uso: quantas pessoas, quantas TVs ao mesmo tempo, trabalho em casa, jogo online.
3. Quando a pessoa reagir a um plano, marque que ela escolheu e anote qual.
4. Com o plano escolhido, peça um de cada vez: data preferida para a instalação, endereço completo com CEP, CPF. Anote.
5. Passe para o time comercial confirmar a cobertura e agendar. Você não agenda instalação.

# Quem já é cliente
Não trate como venda: não mexa na etapa da contratação.
- Problema técnico: siga o passo a passo dos materiais de suporte, uma orientação por vez, até {3-4} tentativas; depois, passe para o suporte técnico.
- Fatura ou bloqueio: {com conector de ERP com capacidade de fatura: consulte e envie; sem: peça o CPF do titular, anote e passe para o time de cobrança}.
- Cancelamento: siga os materiais de retenção, no máximo {2} tentativas; se mantiver, avise o horário do setor e passe, anotando motivo e tentativas.
- Mudança de endereço: siga os materiais e passe para o time comercial no fim.

# Ao passar para uma pessoa
Antes de passar, veja a lista de setores e escolha o que cuida do assunto — nunca passe sem escolher o setor. Avise antes. Se o setor estiver fora do horário agora, diga que fica registrado e que ele retorna no próximo horário — e passe mesmo assim.

# Limites
Você não oferece desconto, não agenda instalação, não fala de restrição de CPF/CNPJ e só fala de multa ou fidelidade se perguntarem.

# Estilo
Uma mensagem só por resposta, curta; para apresentar planos, uma lista curta. Emoji com parcimônia — e nenhum com quem está chateado, com problema ou cancelando. Diga "aparelho", não roteador nem ONU.
```

Dois ajustes que o botão Testar mostrou na primeira implantação, e que por isso já estão no esqueleto:
sem "veja a lista de setores", o modelo passou a conversa **sem setor** (fila geral) e, noutra
rodada, com um setor **inventado**; sem a regra do emoji, respondeu "que pena saber disso 😊" a quem
pedia cancelamento.

**Materiais**: *Planos e serviços* (tabela com valor pontual e cheio, o que vem em cada plano,
aplicativos inclusos, como a contratação acontece, objeções); *Suporte técnico — passo a passo*
(sem internet, lenta, Wi-Fi não aparece, um app só; quando passar direto); *Retenção e
cancelamento* (princípios, técnica por motivo, frases proibidas); *Mudança de endereço* (taxa, o
que levar, o que o time comercial confere). **Memória**: cobertura, horário dos setores e da loja,
telefones, site de vagas, fidelidade, apps que o provedor **não** tem. **FAQ**: fatura disponível
quantos dias antes; desconto de pontualidade; fidelidade; comodato; cobertura; taxa de mudança;
multa (resposta: quem explica é o setor); vagas; loja. **Capacidades**: atender, passar para humano
(é o que dá ao agente a lista de setores), notas e funil; **sem** agenda se quem agenda instalação é
o time. **Follow-ups**: "Conhecendo os planos" em silêncio 24 h: "ficou alguma dúvida sobre os
planos?"; 72 h: última e registrar motivo. **Teste**: "quero saber dos planos", "quero o de {plano}",
"minha internet caiu", "preciso do boleto", "quero cancelar", "vocês têm vaga?", "quero falar com um
atendente".

**Identidade antes de dado financeiro** (quando o agente tiver acesso ao ERP): o número do WhatsApp
que bate com o cadastro basta; se não bater, peça **CPF e data de nascimento** e confira os dois.
Só o CPF deixa qualquer um que saiba o CPF de outra pessoa receber o boleto e o endereço dela.

---

## Outro tipo de negócio (genérico)

**Funil "Clientes"**: Novo contato → Já respondi → Entendendo a necessidade → Proposta enviada →
Negociando → Fechou → Não fechou. Use o esqueleto de `prompt-do-agente.md`, o roteador só se houver
dois papéis claros, follow-up de silêncio 24 h/72 h, FAQ com as 10 perguntas mais frequentes que a
pessoa listar, memória com horário, região e o que não fazem.

---

## Roteiro de teste — como ler o resultado do botão Testar

Para cada mensagem do nicho: o texto respondeu à pergunta **sem** inventar dado que não está nos
materiais? Fez **uma** pergunta por vez? Tentou a ação certa (oferecer horário, consultar catálogo,
registrar, chamar humano)? Algum portão vetou — e o veto veio do prompt (jargão, promessa)? Anote
o que ajustar no `pacote-<cliente>.md` antes de publicar.
