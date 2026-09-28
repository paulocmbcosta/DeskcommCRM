---
impacto: nada_mudou
secao: corrigido
titulo: O assistente não cai mais quando um cliente manda um PDF, e passa a ler o arquivo
---

Todo PDF recebido pelo WhatsApp derrubava o processo do assistente de IA por falta de memória —
inclusive arquivos de poucos KB — e as conversas que ele estava respondendo naquele momento
paravam junto. O arquivo voltava para a fila a cada 10 minutos e derrubava o assistente de novo,
sem aviso na Central. Agora a leitura do PDF roda separada, com limite próprio de memória e de
tempo: o texto do documento chega ao agente, e um arquivo que não dá para ler vira um aviso na
Central em vez de uma queda. Qualquer tarefa automática que volte a derrubar o assistente para de
ser tentada na 5ª queda e abre um aviso dizendo o que aconteceu.
