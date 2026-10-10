---
impacto: capacidade_nova
secao: adicionado
titulo: Transcrição das ligações gravadas, com resumo, no cartão da ligação
---

A ligação gravada pelo telefone agora pode ser **lida**, e não só ouvida. Com a
transcrição ligada, alguns segundos depois de cada ligação gravada o cartão dela
mostra um **resumo curto** e o botão **"Ver transcrição"**, que abre a conversa
com a indicação de quem falou e o momento de cada fala.

**Vem desligada.** Quem liga é o administrador, em
**Conexões › Telefone › Gravação › Transcrever as ligações gravadas**.
Para ligar é preciso:

- a gravação das ligações ligada (sem gravação não há o que transcrever);
- uma chave da OpenAI cadastrada em **Agente de IA › Provedores** — a mesma que
  já transcreve o áudio do WhatsApp. Sem ela, a tela diz e não deixa ligar.

O que vale saber antes de ligar:

- **Só daí para frente.** As ligações gravadas antes de ligar não são
  transcritas.
- **Custa, e o conteúdo sai da instalação.** O áudio de cada ligação gravada é
  enviado à OpenAI, que cobra por minuto de áudio na conta da chave usada. O
  texto que volta vai ao modelo de IA escolhido em **Agente de IA › Provedores**,
  que escreve o resumo — pode ser de outro provedor. Os dois gastos aparecem em
  **Agente de IA › Execuções** e contam no teto de gasto de IA. Com o teto
  atingido, as ligações gravadas nesse período ficam sem transcrição — e não são
  refeitas depois que o teto sobe (ele se ajusta em
  **Agente de IA › Uso e orçamento**).
- **É texto de máquina, de áudio de telefone.** Dá para entender a ligação e o
  resumo costuma ser fiel, mas nomes, números e endereços saem errados com
  frequência. **A indicação de quem falou é uma estimativa**: a gravação mistura
  as duas vozes, e quem falou cada trecho é deduzido pelo conteúdo. Na dúvida,
  ouça a gravação.
- **Quem lê é quem ouve.** Resumo e transcrição aparecem para atendentes,
  gestores e administradores que enxergam a conversa; quem tem papel só de
  leitura não vê. Cada vez que alguém abre uma transcrição, fica registrado na
  auditoria.
- **É apagada junto com a gravação**, no fim do prazo de guarda, e quando o
  contato é anonimizado. A exportação de dados do titular passa a dizer quais
  ligações têm transcrição; o texto, como o áudio, não vai no relatório.

Se a transcrição não sair (chave removida, serviço fora do ar), o cartão diz
"Não foi possível transcrever esta ligação" e a Central avisa, com o caminho
para a aba Gravação. A gravação em si não é afetada.

Ao atualizar não é preciso fazer nada: a mudança no banco chega sozinha, e
nenhuma ligação passa a ser transcrita até alguém ligar o interruptor.
