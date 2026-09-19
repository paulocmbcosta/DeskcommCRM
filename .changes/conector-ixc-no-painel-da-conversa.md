---
impacto: capacidade_nova
secao: adicionado
titulo: Conectores — os dados do IXC (contrato, bloqueio, faturas, OS, conexão e sinal) aparecem ao lado da conversa
---

Provedor de internet que usa o **IXC** pode ligar o sistema ao CRM em
**Configurações › Conectores** (só administrador): informe o endereço do IXC e um
token de API — de preferência **só de leitura e dedicado a esta integração**. O
token é testado antes de ser salvo, fica cifrado e nunca volta a aparecer na tela.

Com o conector ligado, o painel direito da conversa ganha a aba **IXC**. O cliente
é identificado pelo telefone da conversa (e pelo CPF/CNPJ, quando ele escreve de
outro número), e o atendente vê, sem sair do atendimento:

- quem é o cliente e se está **bloqueado** (e por quê);
- o contrato, o plano e as parcelas em atraso;
- o **financeiro**: todas as faturas vencidas, a próxima a vencer e mais uma — com
  o botão **Enviar**, que manda valor, vencimento, link do boleto e linha
  digitável na conversa;
- a **conexão** (online/offline, IP, última queda) e o **sinal da ONU**;
- as **ordens de serviço** e os **atendimentos** abertos no IXC.

Nenhum dado do IXC é copiado para o CRM: tudo é lido na hora, e o CRM guarda apenas
qual cadastro do IXC corresponde a cada contato.

Quem não usa IXC não vê nada de novo: sem conector ligado, não há aba, chamada
externa nem linha no banco. ERP em rede interna (on-premise atrás de VPN) precisa
que o operador da instalação libere o host em `CONECTORES_HOSTS_PRIVADOS`; vazio,
que é o padrão, aceita só endereço público com https.
