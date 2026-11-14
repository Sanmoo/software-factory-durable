# 05 — Qualificação física final e mapa de aceite

Data: 2026-11-14. Branch `implement/software-factory-mvp-05`.

## Tentativas físicas autorizadas (todas preservadas, nenhuma limpeza)

| Tentativa | Fonte | Resultado | Causa / disposição |
|---|---|---|---|
| v1 `y5/q05-qualification-v1` | `9b81383` | prepare/start ok; w1 held na 1ª Write | Produto: `boundMutation` com `stderr:'ignore'` + `ExecProcess.output()`. Corrigido em `c6b4fce`. |
| v2 `y5/q05-qualification-v2` | `5056065` | prepare/start ok; Write real **ok**; w1 held | Oráculo da receita esperava `Successfully wrote 6 bytes`; SDK v3 emite `Successfully wrote to <path>`. Corrigido em `8fa35de` (só teste). |
| v3 `y5/q05-qualification-v3` | `8fa35de` | prepare/start/Write ok; Edit abortou | Produto: mesma classe em `read-tools.ts` (Read/edit-source). Corrigido em `59c2b0a`, teste de contrato vermelho sem a correção e verde com ela. |
| v4 `y5/q05-qualification-v4` | `21701f1` | **todas as fases ok** | — |

Cada tentativa: 1 VM nova (2048 MiB, 2 vCPU, 40 GiB), parada pela API pública ao final (`cessationConfirmed:true`, `termination:unconfirmed`, `guestFinalization:observed`). Isso é uma observação pública do produto. Não prova o fechamento físico de cada FD/writer. Nenhum arquivo de credencial foi aberto, listado ou hashado pelo agente.

## Resultado v4 (receita fixa `dist/test/entrypoints/finite-qualification.js`)

| Fase | Resultados nativos | POSTs aceitos | Capturas inteiras | Recibos de cópia |
|---|---|---|---|---|
| w1 Builder: Write, Edit, Read negada, Bash filtrado, Bash grande + auto-cópia, 3 Reads paginadas | 8 | 9 | 4 | 1 |
| w2 Builder novo: Read da cópia negada | 1 | 2 | 0 | 0 |
| w3 revisor padrão: Read da cópia negada | 1 | 2 | 0 | 0 |
| w4 revisor com seleção explícita do Host: Read permitida | 1 | 2 | 1 | 0 |
| model: `openai / gpt-6-luna / openai-responses` real via store OAuth da Factory | 1 (read) | 2 requisições reais | — | — |

Uso observado no modelo real, como estimativa do SDK e não como cobrança do provedor: 324 + 348 tokens, custo estimado ≈ US$0.00008. Não existe hard cap no provedor. Resultado bruto em `/tmp/software-factory-mvp-05-v4-execution-outcome.json`; observações em `$HOME/software-factory-test/y5/q05-qualification-v4/`.

## Mapa dos critérios de aceite

Os níveis seguem a matriz (V-02, V-03, V-11, V-15). "Físico" significa VM Gondolin/KVM real, worker Node novo, Protocol/Records reais e SDK Pi 1.5.2 v3 adotado.

1. **SDK em worker com recursos explícitos, sem herança pessoal, sem retries.** Físico: o recibo `worker-start` registra o perfil exato e o pid diferente do owner (verificado pela receita em cada fase). Os retries nativos e do provedor ficam em zero por contrato, e os testes locais de `normal-oauth` e `worker-process` cobrem isso. O `doctor`/`configuration` cobrem a ausência de perfil pessoal. ✔
2. **Reserva/autorização antes da ativação; recibo sincronizado antes de modelo/ferramenta.** Físico: o recibo protegido `worker-start` é correlacionado ao boot, à invocação e ao work antes de qualquer resultado nativo. ACK antes de auth: testes `normal-oauth`. A reserva/admissão continua sendo uma precondição do chamador confiável, conforme o contrato, e nenhum motor de admissão foi adicionado. ✔
3. **Conexão vinculada a invocação/papel/ambiente/boot.** Físico: w2/w3 negam por papel e w4 só lê pela seleção do Host. Local: `native-builder-bash` (forja de papel, phase/boot obsoletos, nomes administrativos), `secret-ipc` (replay/ACK forjado), `tool-transport`. ✔
4. **Builder usa a projeção do adapter da instância existente.** Físico: Write/Edit/Bash/Read executam no guest pelo owner vinculado. Não há shell no host nem `VM.exec` direto pela receita. ✔
5. **Filtragem antes de SDK/sessão/arquivo/exibição, incluindo segredo partido.** Físico: no w1 o Bash pequeno produz `█` (o segredo sintético foi emitido partido em dois `printf`) e a receita verifica que a sessão JSONL não contém `q05-secret-v1`/`q05-dummy-key-v1`. O corte físico de chunk não está provado pelos `printf`; o corte partido entre chunks é coberto por testes de componente (`native-owner-read`, Records). ✔ (o nível de cada subcaso está declarado)
6. **Saída volumosa incremental, trecho marcado, paginável; cópia seletiva legível no guest.** Físico: 4 capturas inteiras com hash exato de 1 114 130 bytes, Reads paginadas de cabeça, cauda e meio, cópia `/artifacts/factory-output-*.txt` com recibo do guest, negada para Builder novo e revisor padrão e lida pelo revisor selecionado. ✔
7. **EOF/erro fecha novas chamadas; silêncio não prova desconexão; retorno do SDK não prova cessação.** Físico: as falhas v1 e v3 travaram os passos dependentes sem sucesso fabricado (`WORKER_INTERRUPTED`, provedor sem novos turnos), e o stop reporta `termination:unconfirmed`. EOF em pleno voo: testes locais com Protocol real (`tool-transport` "EOF revokes authority while guest read is pending", `secret-ipc` EOF/exit, `native-owner-read` falha crítica de captura). Não injetei falha física de EOF na VM, e isso fica declarado como lacuna de nível. ✔ (local real-process + falha física natural)
8. **Integração com SDK e modelo reais registra perfil, sessão, ferramenta/resultado e limites; falha crítica impede dependentes.** Físico: a fase model registra o perfil, a sessão nativa verificada, 1 Read com o conteúdo sintético e 2 assistentes `openai/gpt-6-luna/openai-responses` com uso. As falhas v1 e v3 mostram o bloqueio dos dependentes. ✔

## Lacunas declaradas (não são critérios novos)

- Sem prova de limite remoto de cobrança, de RSS ou de cessação física por FD.
- Não houve injeção física de EOF/erro em pleno voo dentro da VM.
- O teste `test/sandbox/gondolin.test.ts` continua `skip:true`.

## Gate local final (§13.4) — HEAD `78fba8d`

dependency-cruiser (199 módulos, 1051 dependências) sem violações; `eslint . --max-warnings 0` ok; `tsc -p tsconfig.json` ok; os 81 arquivos `dist/test/**/*.test.js` rodaram um por vez, cada um com timeout de 60 s: **651 passaram, 0 falharam, 10 pulados**. O primeiro gate, em `21701f1`, mostrou uma regressão de fixture desde `52f4831` em `normal-edit` (13) e `public-bash-copy` (4), em que a telemetria do fixture chegava ao IPC estrito. Corrigido só no teste em `78fba8d`; a rejeição em produção não mudou. Revisão independente estática de `8fa35de`/`59c2b0a`: sem achados.
