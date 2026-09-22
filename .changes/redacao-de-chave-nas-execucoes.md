---
impacto: nada_mudou
secao: corrigido
titulo: IA › Execuções — chave de API ecoada pelo provedor volta a ser apagada da mensagem de erro
---

Quando um provedor de IA recusa uma chave e devolve essa chave de volta na
própria mensagem de erro, o sistema deveria apagar a chave antes de gravar a
mensagem na tela de IA › Execuções. Desde 08/08/2026 essa limpeza tinha um
defeito e nunca apagava nada: se um provedor ecoou a chave num erro, ela
podia ter ficado visível ali para qualquer pessoa com acesso de gerente na
organização. Se você já viu uma chave de API aparecer numa mensagem de erro
em IA › Execuções, troque essa chave junto ao provedor por segurança.
