# 03 — pressão de disco: recusar sem criar preparação irrecuperável

GapAC7 local apósaf56a0b. Sem nova VM, sinal, cleanup histórico, alteração de
imagem4b6, instalação ou mount. Tests na interface Sandbox com statfs externo
simulado e discos ext4/qcow2 novos reais1GiB, nunca enchendo disco host.

## Repro e correção

Antes, prepare criava diretório/owner durável e só então verificava piso/cópias.
Uma recusa CONHECIDA por falta de espaço deixava preparação incompleta; depois de
espaço restaurado, a repetição não distinguia essa recusa de um efeito nativo
interrompido. O Trabalho ficava preso apesar de nenhum disco ter sido produzido.

Regressão pública RED: validate com storageblocked, prepare retorna
INSUFFICIENT_STORAGE_FOR_PREPARATION, mas diretório do Work já existia. GREEN após
admissão para novo ambiente ANTES do mkdir por Work. Verificação de existente vem
antes, sem alocação: idempotência de ambiente saudável não exige novas cópias
nem espaço para elas. mkdirEXCL ainda escolhe inicializador único; disputa EEXIST
usa validação existente, não repete efeitos. Identidade/sync continuam ANTES de
qualquer grow/copy/convert. Erros de I/O depois da intenção continuam incompletos
preservados; não foi criado mecanismo de retry/reparo de efeitos desconhecidos.

O teste restaura espaço e prepara o MESMO Work com sucesso, conferindo SHA do
outro ambiente intacto. Nenhum cleanup/kill automático para obter espaço. Base
maior que configuração também é recusada antes de criar intenção irrecuperável.
Admissão é observação pontual, não reserva ou quota de filesystem.

## Start sob pressão

Sexta variante de filesystem/start: ambiente anterior sinteticamente cessado,
storagebaixo e disco real válido. Recusa INSUFFICIENT_STORAGE_FOR_BOOT sem chamar
manager, alterar current ou modificar SHA do disco. A primeira fixture sobrescrevia
statfs também de /sys/fs/cgroup e provocou PREVIOUS_BOOT_NOT_STOPPED; corrigida
SOMENTE a fronteira da fixture para root/diretório selecionados, preservando
consulta real da hierarquia. Produto não foi relaxado para fazer o teste passar.

Sete focused prepare/filesystem passaram. Revisão independente única38a5ebc9
sem achados, OK no incremento. Gates finais102casos101pass/1VMskip/0fail (~21.87s),
strict compile/build/arquitetura/ESLint72módulos323dependências/diff-check verdes.
LSP sem achados retornados mas3checks inconclusivos push-only, não clean confirmado. Não é teste de ENOSPC real após efeito nativo nem
prova de pressão com VM ativa. Nenhum antigo incomplete/UNKNOWN é adotado ou
liberado automaticamente; preservação conservadora permanece.
