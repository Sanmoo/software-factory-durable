# Evidência 34 / R-HOSTFAULT v3: disco abaixo do piso e cheio numa raiz descartável (V-14.c)

Ticket: [34](../../.scratch/software-factory-mvp/issues/34-candidate-qualification-and-acceptance-coverage.md). Grupo R-HOSTFAULT,
autorizado pelo operador em 2026-11-16 (injeção de falha no host: espaço). Receita
[`test/entrypoints/hostfault34-qualification.ts`](../../test/entrypoints/hostfault34-qualification.ts), namespace
`y5/q34-hostfault-v3`, executada pelo supervisor em 2026-11-16 (18:03:06–18:03:53 UTC) sobre a integração `d7903b3`. Resultados
(sem os manifestos de arquivos): [34-r-hostfault-v3-results.json](34-r-hostfault-v3-results.json).

## Execuções anteriores (consumidas)

- **v1** parou em `image`: o `mkfs.ext4` descartou (hole punch) o arquivo pré-alocado no `/home` btrfs (72 MB de 6 GiB alocados).
  Correção: `chattr +C` no arquivo vazio, `fallocate`, `mkfs -E nodiscard`.
- **v2** parou em `preflight` com `IMAGE_NOT_PREALLOCATED` (6341791744 de 6442450944 bytes). Cerca de 96 MiB foram descartados logo
  após a montagem: a inicialização preguiçosa do ext4 zera tabelas de inode pelo loop, e o loop transforma isso em hole punch no
  arquivo. Correção: `lazy_itable_init=0,lazy_journal_init=0`, verificado por `dumpe2fs` (todos os grupos `ITABLE_ZEROED`).

Nos dois casos a verificação de confinamento parou a execução antes de qualquer efeito da Factory.

## Confinamento (v3)

Imagem ext4 de 6 GiB, NOCOW, totalmente alocada no `/home` btrfs (`imageAllocatedBytes` 6442450944, `imageNocow` true). Montada sem
root pelo operador com `udisksctl` em `/run/media/sanmoo/qhf34v3` (`/dev/loop0`, apoiado exatamente no `disk.img`, dispositivo 1792,
distinto de `$HOME` 55 e `/` 30). A raiz da Factory foi `<mount>/root`. Nenhum preenchimento atingiu o `/home`. Varredura de segredos:
0 ocorrências no namespace e na raiz descartável. Não houve VM, GitHub, modelo ou credencial.

## Resultado

Veredito da receita: **inconclusive** (`NATIVE_CUT_NOT_REACHED`). Nove de onze verificações são verdadeiras e nenhuma falhou.

| Fase | Observado |
| --- | --- |
| floor | 805302272 B livres (< piso de 1 GiB, statfs real em ext4): `validate` storage `blocked`, capacidade `blocked`; `prepare` → `INSUFFICIENT_STORAGE_FOR_PREPARATION` **sem** criar diretório de ambiente; `pause` durável no SQLite da Factory na mesma raiz |
| full | 0 B livres, ENOSPC real atingido; `prepare` recusado sem criar nada; `unpause` no SQLite **aberto pelo proprietário** sem recibo (`ERR_SQLITE_ERROR`): nenhum ACK sem durabilidade; nenhum arquivo da Factory apagado |
| native | **corte não alcançado** (defeito da receita, abaixo): `prepare` recusado na admissão, nada criado, nada apagado |
| release | depois que o operador liberou o espaço (só os arquivos de preenchimento da própria receita): os dois `prepare` tiveram sucesso; o storage reaberto está legível e `paused` = o último pedido com ACK (true); nenhum arquivo apagado ou reescrito |

**Por que o corte nativo não foi alcançado.** A fase `native` removia só os preenchimentos da fase `full` (`f-full`, `f-tail`).
O `f-floor` da fase `floor` continuava lá, então o espaço livre voltava a cerca de 768 MiB, abaixo do piso. A preparação foi
recusada na admissão, antes do `mkdir` do ambiente, e o observador não tinha o que cortar. Não foi tempo nem tamanho da cópia. No `release`, os
dois ambientes preparados ocuparam 1,25 GB no total (6230712320 → 4978913280 B livres; cerca de 0,63 GB cada depois da conversão,
com pico de cópia raw + qcow2), contra 3 GiB exigidos na admissão. Por isso um ENOSPC durante a cópia só acontece com o preenchimento
concorrente que a receita já faz. `incompleteNeverAdopted` também deu falso só por isso: sem
corte, não existia preparação incompleta para adotar. O mesmo Work preparou normalmente no `release`, como esperado para uma recusa
que não deixa intenção.

## Decisão sobre V-14.c: aprovada (S + I)

A expectativa da matriz é "piso de espaço/disco cheio sem exclusão para abrir espaço; arquivo em uso". A lacuna registrada era
"ENOSPC real não simulado (03); recusa por statfs em S". O v3 prova as duas partes em ext4 real (nível I):

- **Piso:** recusa por statfs real, sem criar intenção irrecuperável.
- **Disco cheio:** ENOSPC real; recusa sem efeito; escrita durável no SQLite em uso falha sem ACK e o estado continua consistente
  depois da liberação.
- **Sem exclusão para abrir espaço:** em nenhuma fase.
- **Arquivo em uso:** o storage aberto pelo proprietário (`control.sqlite`, `-wal`) sobreviveu intacto ao ENOSPC.

O corte "ENOSPC depois de um efeito nativo começar" não faz parte da expectativa da V-14.c. Era o limite declarado da evidência 03,
cuja prova I-local, com discos ext4/qcow2 reais, já mostra preparação incompleta preservada e nunca adotada. Fica como **limite
residual**, não aprovado em nível I. A receita foi corrigida para **v4** (a fase `native` libera todos os preenchimentos próprios e
para antes do `prepare` se o espaço não passar na admissão). A v4 não foi executada e não é exigida pela V-14.c.
