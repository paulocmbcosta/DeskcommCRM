---
impacto: nada_mudou
secao: alterado
titulo: As verificações automáticas do projeto rodam uma vez por versão, e não três por mudança
---

Nada muda para quem usa o sistema nem para quem opera uma VPS: a versão que
chega continua passando por todos os testes, pelo banco, pelo build e pela
construção das imagens antes de ser publicada.

O que mudou é o caminho até lá. Cada mudança era verificada por inteiro três
vezes — no PR, de novo ao entrar na `main` e de novo no PR de release. Agora a
verificação completa roda uma vez, no PR de release, e um PR comum recebe só
uma verificação rápida (tipos e padrão de código). O teste de tela automático
deixa de rodar a cada merge e passa a ser disparado à mão.

Um detalhe para quem aponta uma instalação para o canal `latest` em vez de um
número de versão: esse canal deixa de andar sozinho a cada merge e pode ficar
atrás da `main`. Instalação de cliente usa número de versão e não é afetada;
quem quer a última versão lançada usa `stable`, que continua andando a cada
release.
