---
impacto: capacidade_nova
secao: adicionado
titulo: Menu de voz (URA) no telefone, falas gravadas com a voz da ElevenLabs e aviso de instabilidade por time
---

Quem liga para um número SIP da empresa pode ouvir um **menu de voz** e escolher o time pela
tecla: "Para Suporte, digite 1. Para Financeiro, digite 2." O menu é montado em
**Conexões › Telefone › Menus** a partir das opções (tecla → time, mais o time padrão), e cada
número escolhe, em **Números**, se toca direto num time ou toca o menu. Quem não digita nada ou
aperta uma tecla que não existe ouve o menu de novo e, depois da terceira vez, vai para o time
padrão. A conversa da ligação acompanha o time escolhido, a não ser que já tenha um atendente, e
o cartão da ligação conta o que aconteceu ("No menu Principal, digitou uma tecla que não existe
e foi para o time padrão, Suporte"). Cada menu mostra os últimos 7 dias: quantos escolheram cada
tecla, quantos não escolheram, quantos erraram e quantos desligaram no menu.

As falas são geradas pela **ElevenLabs**, com a conta da própria empresa: a chave é cadastrada
em **Credenciais de IA** (o cartão aparece com a telefonia ligada; a chave é validada na hora e
depois a tela mostra só os 4 últimos dígitos), a voz é escolhida em **Voz e falas**, e cada fala
passa por uma prévia: gera, ouve no navegador e só então "Salvar e usar". A ElevenLabs só é
chamada na prévia, nunca numa ligação; o mesmo texto com a mesma voz não é cobrado duas vezes, e
o limite é de 30 prévias por hora. Além do menu há três falas: **aguarde** (a cada ~40 s de
espera), **ninguém atendeu** e **fora do horário**, pela agenda do time — o texto sugerido já traz
o WhatsApp da empresa. Sem a fala de fora do horário, a ligação fora do horário segue como antes.

Em **Configurações › Times**, gerentes e admins ligam um **aviso de instabilidade** por time,
com prazo (1 h, 2 h, 4 h ou até desligar): quem liga para aquele time ouve o aviso antes da fila,
e uma faixa no topo do CRM avisa a equipe enquanto ele estiver ligado. O aviso desliga sozinho no
fim do prazo. A Central ganha três avisos, cada um com o link da tela que conserta: uma fala que
não tocou (`phone_prompt_unplayable`; a ligação seguiu sem ela), o aviso que desligou sozinho
(`phone_emergency_expired`) e o menu que manda para um time arquivado (`phone_menu_team_archived`).

Muda para toda ligação perdida, com ou sem menu: o "Ligar de volta" na Central passa a dizer o
time — "Ninguém do time Suporte atendeu. Ligue de volta pela conversa." —, no idioma da empresa;
quem desligou no menu aparece como "O cliente desligou no menu do telefone.". O registro da
ligação na conversa (`metadata.voice_call`) ganha `motivo`, `menu` e `ouviu_aviso`; os campos
que já existiam não mudaram.

Uma limitação conhecida: a prévia que ninguém salvou sai do armazenamento 24 horas depois de
CRIADA, e não do último uso. Quem volta a um texto antigo e demora a salvar pode ter o "Salvar e
usar" recusado, pedindo a prévia de novo — o que gasta uma síntese na conta da ElevenLabs.

Também nesta versão: repetir um pedido de criação com o mesmo `Idempotency-Key` volta a devolver
a primeira resposta — todo repetido virava `409 idempotency_conflict` (na API de modelos de
mensagem, e agora também nos números e menus do telefone, que passam a aceitar o header);
quando o servidor pede para esperar mais de 10 segundos, a tela mostra a mensagem na hora em vez
de ficar presa; e as telas do telefone nunca mostram cru um erro do proxy (504, página HTML).

Sem a chave da ElevenLabs e sem menu, as ligações seguem como antes, fora o texto do aviso de
perdida. O `update.sh` cria as tabelas novas e o volume das falas (`telefonia-falas`, em
`/var/lib/telefonia/falas`) sozinho, sem nada a editar no `.env` nem no compose. Quem atualiza à
mão, sem ele, recria também o `worker` e o `asterisk`, e não só o `app`: sem isso o Asterisk fica
sem o volume e pula as falas. Ainda não há transferência nem ramais.
