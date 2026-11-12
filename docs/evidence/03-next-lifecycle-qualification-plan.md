# Próxima qualificação proposta — fixa, limitada, ainda não autorizada

Preparar este plano/driver não inicia nem autoriza VM. Autorizações anteriores,
incluindo u3, consumidas. Nenhum teste de imagem exploratório será retomado.

**Execução posterior:** o operador autorizou explicitamente o orçamento proposto;
os dois boots condicionais foram executados e encerrados. [Evidência v3](03-v3-two-boots-qualified-subset.md).
Nenhum terceiro boot autorizado; este texto preserva o plano que precedeu a prova.

## Escopo a solicitar

- Um ambiente novo `/home/sanmoo/software-factory-test/v3`, se ausente.
- **No máximo dois boots sequenciais desse mesmo ambiente**, nunca simultâneos.
- Cada boot KVM/2GiB/2vCPU, mesmo disco virtual40GiB preservado e mesma imagem
  assets32/assets pin4b6e90d356b2f93a2f7ec014f2778c1ce2fea8cfd8a19894fdb8112aa95038c1.
- Startup SDK30s/grace30s, sem tuning/fallback/retry/terceiro boot; sem agentes,
  credenciais, rede, pulls, chamadas GitHub/modelo, hostmount/install/sudo.
- Fresh capacity/preflight antes de efeitos, respeitar orçamentoRoot80GiB/reserva
  e limites de memória/CPU históricos; inventory não libera UNKNOWN/noRetry.
- Preservar imagens/discos/evidências/failed units. Não remover históricos.

## Primeiro boot: gate para o segundo, não teste para repetir até passar

O driver manual qualify-public-lifecycle.ts está preparado para v3, mesmo pin,
fonteexata40hex e criação exclusiva de root. Rerun não pode adotar/recriar ambiente.
Usa prepare/start/observe/stop públicos e testemunha física própria de VMM, com
stop em finally. Console/debug desligados; não usar snapshot vazio como diagnóstico.

Exigir sucesso operacional, active antes de stop, guestFinalizationobserved,
cessação independente pós-finally por host/NS/full-root/CG/metadados próprios.
Unit de sucesso pode ser coletada: not-found não é por si só prova de cessação,
nem defaultExecStatus0 prova de exitstatus. Nenhum sync/receipt sozinho é graceful.
Se primeiro gate falhar: **não fazer segundo boot nem tentar outra imagem**.

## Evidência independente de filesystem e estado Docker

Depois de cessação, ferramentas nativas read-only/snapshot privado, sem montar
FS no host nem alterar qcow2 original. Conferir standalone/capacidadevirtual,
e2fsck-fn e capacidade ext4 real40GiB. Recusar qualquer erro/indeterminação.

O perfil Docker29 cria seu estado no disco em /var/lib/docker. Pode-se observar
somente o identificador não secreto /var/lib/docker/engine-id por debugfs read-only
sobre snapshot: validar comprimento/forma e registrar **somente hash**, nunca
conteúdo guest arbitrário. Antes, provar que o template não traz esse identificador
preexistente. Não ler key.json, chaves ou credenciais, nem escolher fallback de
arquivo. Se não houver evidência inequívoca desse estado, parar e reportar a lacuna,
não fabricar outro teste/boot. Isso é evidência limitada de persistência do estado
criado pelo daemon, não substitui teste completo das ferramentas/workspace.

### Pré-inspeção local já realizada, sem nova VM

`/home/sanmoo/software-factory-test/engine-id-inspection-v1/result.json` registra
viabilidade após nova observe de u3 com cessação confirmada. Snapshot read-only
privado de seu disco: e2fsck-fn exit0, FS823132160B vs virtual42949672960B,
identificador presente após aquele boot e ausente no template. Guardado somente
SHA256 do identificador, não valor/chave. SHA do qcow2 original e mtimeNs/ctimeNs
permaneceram idênticos; recurso histórico não foi alterado/removido. Snapshot
retido. Isso confirma o caminho da evidência, **não** persistência entre boots,
nem finalização graciosa (u3 ainda tinha guestFinalizationunavailable).

## Segundo boot, condicionado ao primeiro

Nova chamada pública start para o MESMO EnvironmentRef, mesma configuração/pin,
novo BootRef e VMM próprios distintos, check conservador de disco antes do efeito.
Nunca recriar template/repreparar ambiente para contornar preservação.

Repetir operacional/active-stop/finalização/cessação e comparar hash do estado
Docker persistido após a segunda parada com o da primeira. Nenhum acesso direto
SDKVM fora do adapter. O follow-up é uma chamada pública controlada do operador,
não um novo método de worker ou seam de teste no produto. Registrar pontos não
comprovados, inclusive que finalização observada não certifica parada graciosa.

## Saída

Passou: congelar resultado e avançar aos critérios ainda pendentes, não fazer
terceiro boot por curiosidade. Falhou/inconclusivo: interromper fase, preservar,
diagnosticar localmente contra sinal específico; nenhuma variante de imagem.

Mesmo sucesso não fecha sozinho ticket03: projeções de ferramentas/roles,
isolamento entre ambientes, owner-loss e remove ainda exigem implementação/provas.
Não há merge/push/cleanup nem liberação de Slot baseada somente em receipts.
