---
impacto: nada_mudou
secao: corrigido
titulo: A caixa de entrada volta a ficar rápida — a regra de quem vê cada conversa ficou 12 vezes mais barata
---

Com vários atendentes conectados, o sistema ficava lento e o banco chegava ao limite de
conexões. A causa estava na conferência de quem pode ver cada conversa, que o banco faz a cada
recontagem das abas e a cada atualização em tempo real, conversa por conversa. Essa conferência
agora é feita numa consulta só. Quem vê o quê continua exatamente igual.
