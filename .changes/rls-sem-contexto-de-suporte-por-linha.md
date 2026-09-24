---
impacto: nada_mudou
secao: corrigido
titulo: Inbox e demais telas até 3× mais rápidos no banco para quem não é administrador da plataforma
---

As regras de segurança do banco consultavam, a cada linha lida, o contexto de
suporte temporário — que só vale para administradores da plataforma e, para todos
os outros usuários, sempre dava vazio. Agora essa consulta só acontece para quem é
administrador da plataforma. O que cada pessoa vê não muda; medido em produção, a
contagem de uma aba do Inbox caiu de ~175 ms para ~52 ms. A migration 0278 é
aplicada sozinha pelo `update.sh`.
