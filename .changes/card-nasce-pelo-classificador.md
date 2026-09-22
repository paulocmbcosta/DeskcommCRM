---
impacto: capacidade_nova
secao: adicionado
titulo: Funil — o card pode nascer só para conversas comerciais
---

Em **CRM › Etapas do funil**, a seção nova **Quando o card nasce** tem duas opções. **Toda conversa vira card** é o comportamento de sempre e continua sendo o padrão: nada muda até alguém escolher a outra.

**Só conversas comerciais**: a primeira mensagem deixa de abrir card. A cada mensagem de quem ainda não tem card, a IA (o Jev, da TypeSafe, pela OpenRouter) lê as últimas falas do atendimento atual e decide se o assunto é contratação, mudança de plano ou conhecer planos. Suporte, financeiro e cancelamento não contam como comerciais. Quando abre, a linha do tempo da conversa diz por quê, por exemplo "conversa identificada como comercial (93%) — assunto: mudança de plano". Quem já tem card não gera consulta nenhuma. A **certeza mínima** (60 a 90%) regula o quanto a IA precisa estar segura.

Como a decisão é refeita a cada mensagem, o card pode nascer no MEIO da conversa — na mensagem em que ela vira comercial, não necessariamente na primeira. Automações de "card criado" (webhooks, follow-ups) disparam nesse momento, não antes. Conversa que só tem áudio sem transcrição (sem uma chave de transcrição configurada, o áudio não é lido) também faz o card nascer, mas "sem classificar" — a linha do tempo diz que a mídia não pôde ser lida, em vez de dizer o assunto.

Precisa de uma chave da **OpenRouter** cadastrada e validada em **IA › Credenciais** (ou `OPENROUTER_API_KEY` na instalação) — sem chave, a tela recusa ligar a regra. Cada consulta custa uma fração de centavo de dólar e aparece em **IA › Execuções**. Se a IA não conseguir responder (chave sem saldo, serviço fora do ar), o card nasce como antes, e a linha do tempo registra a causa.

Para decidir, as últimas falas do atendimento são enviadas à OpenRouter e à TypeSafe (dona do Jev); se a chave usada for a da instalação (`OPENROUTER_API_KEY`), elas passam pela conta de quem administra a instalação.
