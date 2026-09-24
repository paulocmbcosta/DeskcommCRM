---
impacto: nada_mudou
secao: corrigido
titulo: O Inbox não derruba mais o banco quando chegam mensagens com muitos atendentes logados
---

Cada aviso de tempo real ("conversa mudou", "mensagem nova") fazia TODAS as telas
abertas do Inbox recarregarem a lista e as contagens das abas na hora. Com vários
atendentes logados, uma única mensagem virava centenas de consultas e saturava o
banco. Agora cada tela junta os avisos e recarrega no máximo uma vez a cada
poucos segundos. As mensagens da conversa aberta continuam aparecendo na hora.
