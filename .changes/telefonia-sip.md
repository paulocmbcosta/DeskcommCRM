---
impacto: capacidade_nova
secao: adicionado
titulo: Telefone no CRM — fazer e receber ligações pelos números SIP da empresa
---

O atendente passa a ligar e atender pelo próprio navegador, usando as contas SIP que a empresa
já contratou de uma operadora de telefonia. Os números são cadastrados pela tela, em
**Conexões › Telefone** (servidor, usuário, senha, o número e o time que recebe), quantos a
empresa tiver; a senha é guardada cifrada e nunca volta para a tela, e cada número mostra se
está Conectado ou por que falhou.

A ligação recebida toca no navegador de um atendente disponível do time por vez, começando por
quem atendeu menos ligações hoje: 20 segundos para cada um, duas voltas. Se ninguém puder
atender, quem ligou ouve música por até 2 minutos; depois disso a ligação vira aviso de
"Ligar de volta" na Central. Para ligar, há o botão **Ligar** na conversa e na ficha do contato
e um discador no alto da tela. Cada contato ganha uma conversa de telefone no Inbox, com um
cartão por ligação (quem atendeu, quanto durou) e espaço para nota interna.

Por segurança, só se liga para números brasileiros com DDD: internacional, 0300, 0500, 0800,
0900 e 400x ficam bloqueados, e são no máximo 5 ligações de saída ao mesmo tempo por empresa.
O telefone do navegador só se conecta para quem está logado como atendente (ou acima) no
próprio CRM. O servidor do número precisa ser o endereço público da operadora — endereço
interno, `localhost` ou nome sem domínio são recusados —, e trocar o servidor, a porta, o
transporte ou o usuário de um número pede a senha de novo.

Nada muda para quem não usa: a telefonia vem desligada, e a atualização só prepara a senha
interna dela no `.env`. Para ligar, quem administra o servidor acrescenta `telefonia` em
`COMPOSE_PROFILES`, preenche `TELEFONIA_ARI_URL=http://asterisk:8088` e roda o `update.sh`; a
aba Telefone explica isso enquanto estiver desligada. O áudio usa a faixa UDP 20000–20039. Se
`TELEFONIA_IP_PUBLICO` for preenchido, tem de ser o IPv4 público da máquina: com outro valor o
serviço de telefonia não sobe e diz no log o que corrigir.
Ainda não há menu de voz (URA), transferência, gravação nem transcrição.
