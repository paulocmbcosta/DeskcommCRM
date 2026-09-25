---
impacto: capacidade_nova
secao: adicionado
titulo: O tom do cliente aparece na conversa, no card e num filtro, e a IA passa a conversa irritada para o setor certo
---

- **Tom do cliente na tela:** o sistema já dava uma nota ao tom de cada mensagem do cliente
  (de 0 a 1), mas ninguém via. Agora o topo da conversa mostra a faixa e a nota, por exemplo
  "Crítico · 0,05", com o pior momento do atendimento na dica. As faixas são Satisfeito,
  Neutro, Insatisfeito e Crítico.
- **Card das filas:** mostra "Insatisfeito" ou "Crítico" quando o cliente pede atenção. As
  mensagens do cliente com nota baixa ganham um ponto colorido ao lado da hora.
- **Filtro:** o botão **Insatisfeitos** (em Todas e Minhas) mostra só essas conversas.
- **IA e sentimento baixo:** o tom baixo **não transfere mais sozinho** para a fila sem time
  com a frase genérica. O momento entra na linha do tempo da conversa, e a IA recebe o
  aviso, acolhe o cliente e passa para o **setor que cuida do assunto**.
- **Novo ajuste por agente:** em Agentes › Operação do agente, o campo "Cliente muito
  insatisfeito abaixo da nota" define esse limite (padrão 0,30).

A migration 0280 é aplicada sozinha pelo `update.sh`. As notas aparecem a partir da próxima
mensagem de cada cliente.
