# Ticket 33 — atualização com compatibilidade verificada e migração recuperável

Escopo: troca explícita de release por procedimento que preserva Trabalho e Pergunta pendentes, recusa
incompatibilidade antes de alterar estado e permite concluir ou recuperar migração suportada interrompida
(spec §5.2, §6.1, §11.4; V-01, V-07, V-12, V-16). Tudo abaixo foi executado localmente, sem rede, GitHub,
credenciais, modelo, VM/QEMU, systemd ou sudo. **A receita real (releases construídas com os assets reais)
não foi executada aqui**: ela está pronta para o supervisor, mais abaixo.

## O que foi implementado

| Peça | Arquivo | Observação |
| --- | --- | --- |
| Formatos do storage do Controle, inspeção somente leitura e porta operacional | `src/control/durable/format.ts`, `store.ts` | Exame **antes** de existir Session, pela API pública `Storage` do Pi Durable (`scanDocuments`/`document`/`scanTasks`). Esquema Pi Durable diferente do suportado nunca é aberto por `SqliteStorage.open` (que migraria implicitamente). |
| Formato 2 e migração 1 → 2 | `src/control/durable/admission.ts` (`factory.installation` v2), `migration.ts` | Única migração suportada, um commit Session, idempotente por `upgradeId`, verificada pelo digest dos documentos preservados. |
| Ciclo do controlador (evidência de parada limpa) | `migration.ts` (`recordRunStart`/`recordRunEnd`), `control.ts` | Início durável antes de polling/despacho; fim `clean` só depois da cessação/persistência confirmadas; crash deixa `current` sem fim. `status.storage.previousRun`. |
| Declaração de formato na release | `src/contracts/index.ts` (`controlStorageCompatibility`), `release-build.ts` (`metadata.storage`), `release.ts` (`releaseStorageSupport`, `releaseLauncher`) | Manifesto sem a declaração = release anterior ao ticket 33 (opera só o formato 1). O launcher gravado tem de reproduzir o pin do manifesto. |
| Dependências de ambientes | `src/sandbox/asset-dependencies.ts` (`environmentDependencies`) | Somente leitura por caminhos host; pin de assets/perfil com que cada disco foi preparado. |
| Upgrade (`check|apply|status|resume|rollback`) | `src/entrypoints/controller/upgrade.ts`, `controller.ts`, `cli.ts` | Executado pela release **nova**, sob o mesmo `flock` do storage canônico (sem proprietário concorrente). |
| Guardas de boot | `src/entrypoints/controller/owner.ts` | Journal incompleto → `UPGRADE_INCOMPLETE`; storage fora do formato → `STORAGE_MIGRATION_REQUIRED`/`STORAGE_INCOMPATIBLE`; antes de abrir o storage. |

Não há cópia, backup ou restauração de storage; não há agendamento, certificação de cópias, migração de
disco/base nem remoção de assets. Proteção contra perda do storage permanece externa e não desfaz GitHub.

## Procedimento do operador

1. Com a release atual: `./factory pause`, depois parar o controlador (Ctrl+C ou parada do serviço) e
   confirmar a saída 0. A intenção de parar não vale como parada limpa: o formato 2 registra o fim do run
   apenas após cessação/persistência; formato 1 não tem esse registro (o check marca `unverified` e o boot
   da release nova reconcilia como após interrupção).
2. Extrair a release nova **ao lado** da anterior, sem extrair o launcher e sem sobrescrever nada:
   `tar -xpf software-factory-<novo>.tar -C <root> --skip-old-files releases assets`.
3. `env -u NODE_OPTIONS -u NODE_PATH -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 <root>/releases/<novo>/node/bin/node <root>/releases/<novo>/dist/src/entrypoints/cli.js upgrade check`
   (somente leitura). Verifica: release alvo (integridade, local, Node privado, assets), release selecionada
   preservada, `config.yaml` e perfil de worker do alvo, backend/esquema/documentos/registry do storage,
   pausa, parada limpa registrada, protocolo, perfil/skill pack/sessões preservadas e dependências de
   ambientes/assets. Qualquer `blocked` recusa sem alterar nada; nunca se apagam ou ressubmetem tasks/documentos.
4. `... upgrade apply` — se o storage exige migração, só com o pedido explícito `--migrate factory-storage-1-to-2`.
   O apply verifica tudo de novo, grava `data/upgrade/journal.json` (fsync + rename), executa a migração em um
   commit, troca a seleção explícita (`<root>/factory`, rename atômico do launcher fixado pelo manifesto novo)
   e fecha o journal. O launcher anterior é guardado byte a byte só para o rollback da seleção.
5. `./factory run` (a instalação continua pausada; o boot reconcilia), inspecionar `status`, `list`, `show`,
   responder Perguntas pendentes; só então `./factory unpause`.

Interrupção: o journal registra `migrating → migrated → selecting → completed`. Enquanto não terminal, o
controlador da release nova recusa iniciar; a release antiga não opera o storage migrado (documento
`factory.installation` v2 é "newer version" para ela, recusa sem escrita). `upgrade resume` reverifica e
conclui; `upgrade rollback` reseleciona a release anterior **somente** se o storage ainda está no formato
que ela opera (antes do commit da migração); depois dele, `ROLLBACK_FORMAT_UNSUPPORTED` — sem rollback
universal. Limitação conhecida: uma release anterior ao ticket 33 não lê o journal; entre o journal e o
commit da migração ela ainda opera o formato 1 intacto, e o `resume` reverifica tudo antes de migrar.

## Critérios de aceite → testes (nível de evidência)

| AC | Teste | Nível |
| --- | --- | --- |
| 1 Pausar/parar confirmado; crash ≠ parada limpa; release separada preservada | `test/control/storage-format.test.ts` (ciclo clean/crash/sem escrita no read-only); `test/entrypoints/upgrade.test.ts` (pausa e parada não limpa bloqueiam; release anterior íntegra); `test/entrypoints/release-upgrade.test.ts` (release construída extraída ao lado; fim `clean` registrado após Ctrl+C) | F (Control+Pi Durable+SQLite reais) / I-local |
| 2 Verificação completa antes de mudar estado; incompatível bloqueia sem apagar/ressubmeter | `storage-format.test.ts` (tipo desconhecido, versão nova, esquema Pi Durable diferente); `upgrade.test.ts` (configuração inválida, documento desconhecido, ambiente com outros assets, snapshot idêntico, sem `data/upgrade`) | F / I-local |
| 3 Só migração suportada e pedida; preserva IDs/índices/ciclos/FIFO/Perguntas/respostas/reservas/limites/efeitos | `storage-format.test.ts` (recusa implícita, digest preservado, idempotência); `upgrade.test.ts` (`NOT_REQUESTED`/`NOT_APPLICABLE` sem mudança) | F / I-local |
| 4 Interrupção detectável com caminho de conclusão/recuperação; nunca estado parcial aceito | `upgrade.test.ts` (SIGKILL real após journal, migração e seleção; controlador recusa; resume conclui; rollback antes do commit; recusa depois) | I-local (processo real morto) |
| 5 Inicia pausada, registry compatível, inspeção antes de despausar; Pergunta respondível | `storage-format.test.ts` (show/status/question após migração, resposta durável); `release-upgrade.test.ts` (release construída: `run` pausado, `question`/`answer` pelo protocolo real, saída 0) | F / I-local |
| 6 Discos/base/perfil não migrados; assets dependentes não removidos; release antiga só formato compatível | `upgrade.test.ts` (ambiente com outros assets bloqueia; rollback recusado no formato 2); `release-upgrade.test.ts` (inventário da release anterior inalterado) | I-local |
| 7 Provas reais (Pergunta pendente, incompatibilidade, migração interrompida) por fronteiras públicas | **Receita** `test/entrypoints/release33-qualification.ts` (não executada aqui) | R pendente |
| 8 Sem backup/restauração/agendamento/certificação | por construção (nenhum código copia storage); `upgrade.ts`/`migration.ts` | S |

Dublês: execução (Sandbox/Workers/credenciais) e GitHub nos fixtures de Pergunta; as releases de
`upgrade.test.ts` são árvores sintéticas com manifestos reais (sem código). Nada disso comprova VM, worker,
modelo ou GitHub reais.

## Receita real one-shot (supervisor)

Arquivo: `test/entrypoints/release33-qualification.ts` (import e `--plan` inertes; teste
`release33-qualification.test.ts`). Pré-requisitos: checkout limpo e compilado (`tsc`), perfis SDK privados
preparados, `r32-v2/build` intacto (somente leitura), nenhuma base/tombstone `r33-v1` existente, ~6 GiB livres.

```sh
N='env -u NODE_OPTIONS -u NODE_COMPILE_CACHE NODE_DISABLE_COMPILE_CACHE=1 /home/sanmoo/.local/share/mise/installs/node/24.21.0/bin/node'
$N dist/test/entrypoints/release33-qualification.js --plan
for phase in build install-v1 seed-v1 extract-v2 check-and-refusals interrupted-migration start-v2; do
  $N dist/test/entrypoints/release33-qualification.js $phase || break
done
```

- Base nova `/home/sanmoo/software-factory-test/r33-v1` (raiz `root/`, `build/`, `observations/`), tombstones
  irmãos `r33-v1.<fase>-intent.json`; cada fase roda uma vez; nada é repetido ou reparado.
- v1 = `r32-v2/build/software-factory-mvp-32.1.tar` (formato 1, sem ferramenta de upgrade), somente leitura.
  v2 = `mvp-33.1` construída deste checkout com assets34 (`8efa506a…`).
- `config.yaml` sem repositórios (nenhum alvo de polling, nenhum token, Perguntas recusadas localmente) e
  `credentials/github-app.pem` placeholder não secreto, nunca lido.
- `seed-v1`: sob o `flock` canônico, o Control atual (execução/GitHub dublados em processo) produz o
  Trabalho #3 esperando Pergunta publicada aberta e o #4, pausa e parada limpa; esse estado é reexpresso
  como formato 1 pela API pública do Pi Durable. Depois o **controlador real da v1** (`./factory run`) o
  opera: `status`/`question` pelo protocolo real, SIGINT com saída 0. (O gate arquitetural proíbe import
  dinâmico de caminho calculado, então a receita não carrega o código da v1 em processo.)
- `check-and-refusals`: check `UPGRADE_MIGRATION_REQUIRED`; recusa pelo lock com a v1 rodando (73);
  `unpause` pela v1 → check `UPGRADE_INCOMPATIBLE [upgrade:pause]`; `pause` de novo; apply sem `--migrate` →
  `UPGRADE_MIGRATION_NOT_REQUESTED`; digest preservado/launcher/journal inalterados.
- `interrupted-migration`: prova primeiro que todo `dist/src` distribuído pela v2 é idêntico byte a byte ao
  deste checkout (do qual ela foi construída); o código de upgrade morto por SIGKILL após o journal (storage
  formato 1) e, no resume, após o commit da migração; `./factory run` (launcher v1) recusado sem escrita;
  rollback `ROLLBACK_FORMAT_UNSUPPORTED`; resume `UPGRADE_COMPLETED`; uma só migração registrada.
- `start-v2`: doctor seleciona `mvp-33.1`; `run` pausado; `status`/`list`/`show`/`question`; `answer` local;
  Pergunta respondida; saída 0; `upgrade status` com `lifecycle.last.end = clean`.
- Limites: sem rede/GitHub/credencial/modelo/VM/systemd/sudo; disco de pico ~6 GiB; build ≤ 15 min,
  comandos ≤ 120–300 s; 0 retentativas. Expectativas completas em `plan().expected`.
- Lacunas assumidas da receita: a Pergunta é criada com execução dublada (não por Builder real) e o storage
  formato 1 é reexpresso a partir do estado do Control atual (a v1 real só o opera, não o escreve); o caso
  `unpause` com a v1 confia em não haver Trabalho elegível (nenhum repositório configurado); a migração é
  exercida no par real r32 → r33, não em ambientes/discos reais.

## Decisões de desenho abertas (para o operador)

1. **Interface pública do Controle**: além das três operações aprovadas, `src/control/index.ts` exporta
   funções de bootstrap `inspectStorage`/`migrateStorage` (como `openControl`), chamadas pelo upgrade sob o
   `flock`. Alternativa seria uma quarta operação; precisa de confirmação.
2. **Leitura offline do storage pelo upgrade**: o `check` lê o storage sem controlador (sob o mesmo lock),
   apenas para compatibilidade/contagens/digest — não é leitor operacional paralelo, mas é leitura offline.
3. **Release anterior ao ticket 33 não vê o journal** (ver acima); o formato 1 continua íntegro até o commit.
4. Composição com o ticket 26: o fim `uncertain` do `run` do 26 deve ser registrado como fim não limpo
   (`recordRunEnd(..., 'uncertain')`) no rebase; o boot reconciliador do 26 continua sendo o caminho após crash.
