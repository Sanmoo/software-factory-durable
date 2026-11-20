# Validar Docker e transporte em Lambda MicroVMs

Status: resolved
Type: prototype
Label: wayfinder:prototype
Map: [Software Factory v2 — ambientes reconstruíveis em Lambda MicroVMs](../map.md)
Blocked by: 01

## Question

Lambda MicroVMs suporta o perfil real de Docker e ferramentas remotas da fábrica, com complexidade
operacional aceitável, reconstrução via Git e vida limitada por boot?

## Authorization gate

Concordância em princípio não autoriza provisionamento imediato. Antes de trabalhar, marcar claimed;
antes de executar na AWS, obter confirmação específica de conta, região, permissões, teto de custo,
prazo e cleanup. Usar apenas repositório sintético e credenciais de teste mínimas, nunca código privado,
credenciais pessoais, chave emissora real ou banco do controlador. Não instalar serviços no host sem autorização.

Não presumir o custo como "poucos dólares"; levantar preços e dependências efetivas e aprovar orçamento.
Inventariar todos os recursos criados e removê-los conforme o plano autorizado, reportando resíduos/custos.

## Scope and evidence

Partir da [direção aprovada](01-lambda-microvms-direction.md#answer), revalidar documentação atual
antes do experimento e registrar região, arquitetura, imagens/digests, versões, parâmetros, comandos,
saídas, custos e limites. Separar suporte documentado, observação experimental e inferência.

### Docker e perfil do repositório

- Confirmar disponibilidade do serviço/APIs e semântica de `additionalOsCapabilities: ["ALL"]`.
- Medir capacidades efetivas, cgroups, storage driver, rede, permissões e espaço de disco.
- Validar `docker info`, build/run, Compose com rede e DNS, bind mounts, volumes e port mapping.
- Executar teste Testcontainers com Ryuk e observar criação, comunicação e cleanup reais.
- Validar DNS dos containers; relatos da sessão sugerem particularidades de UDP/resolver.
  Não adotar workaround de terceiro como garantia universal.
- Se suspend/resume for avaliado, testar integridade de daemon, containers e rede após retomada.
  Não tornar suspensão necessária para a reconstrução por Git nem presumir sobrevivência dos processos.

### Transporte de produção e papéis

- Provar SSH sobre WebSocket através de `HTTP_INGRESS`, sem usar `SHELL_INGRESS` como atalho de produção.
- Registrar componentes prontos, versões e custo total de configuração/operação; não construir servidor exec
  próprio silenciosamente se o túnel falhar. Reportar o bloqueio e voltar à decisão de alternativa.
- Validar host key, autenticação/escopo do acesso, geração/injeção de chave efêmera e expiração de token AWS.
- Testar streaming de stdout/stderr, exit code, arquivos binários, desconexão, reconexão e interrupção.
  Distinguir canal fechado de processo encerrado e resultado desconhecido de comando não executado.
- Demonstrar Builder com ferramentas necessárias e revisores somente leitura: não basta instrução ao modelo.
  Impedir bypass por shell/SFTP/port forwarding, acesso a outras sessões e credenciais indevidas.
- Verificar visibilidade/proteção dos componentes de transporte e segredos diante do código do repo.

### Vida limitada, Git e recuperação

- Confirmar teto de vida e contagem de tempo suspenso nas APIs/documentação atuais.
- Com repo sintético, testar push WIP e gate: untracked, alterações, stash, commits sem push,
  remoto indisponível e ref local de acompanhamento desatualizada. Nenhum caso vira preservação presumida.
- Terminar a primeira MicroVM, confirmar cessação e reconstruir outra pelo mesmo commit remoto,
  incluindo reinstalação do ambiente e retomada compatível do contexto externo.
- Exercitar troca antecipada com limite reduzido, sem esperar oito horas se houver mecanismo fiel.
- Injetar falha antes do push: reportar perda e retomar do último estado publicado por sessão substituta.
- Registrar APIs/estados/evidências de propriedade e término, sem confundir pedido de parada com cessação.

### Rede, limites e custo

- Avaliar `INTERNET_EGRESS`, DNS, acesso indevido a endpoints privados/metadados e diferenças em relação
  à mediação HTTP(S) do MVP. Registrar qualquer relaxamento que ainda precise de aprovação explícita.
- Testes VPC só se necessários e incluídos no orçamento aprovado; não criar NAT ou outros recursos fixos por padrão.
- Levantar duração de conexões, quotas, disco, arquiteturas, disponibilidade regional, custo de compute,
  imagens, snapshots, logs e transferência. Não tratar os números da pesquisa da sessão como preços vigentes.

## Exit criteria

Entregar relatório reproduzível com evidências por cenário, custo real e inventário de cleanup.
Para Docker e transporte, classificar separadamente: funciona no perfil testado, falha conhecida ou
indeterminado, com causa/limite e fonte. Um smoke de `docker run` não aprova Testcontainers.

Resultado negativo ou serviço indisponível é resultado válido: não inventar suporte nem trocar de
serviço/arquitetura automaticamente. O ticket seguinte deverá incorporar os achados e voltar ao operador
quando houver mudança de direção. Esta prova não equivale ao aceite completo da fábrica.

## References to revalidate

Fontes trazidas pela pesquisa documental da sessão; não revalidadas independentemente neste registro:

- [Guia Lambda MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html).
- [Imagens e capacidades](https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html).
- [Criação e duração](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html).
- [Rede](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html).
- [Segurança](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html).
- [Troubleshooting](https://docs.aws.amazon.com/lambda/latest/dg/microvms-troubleshooting.html).
- [API CreateMicrovmImage](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CreateMicrovmImage.html).
- [Toolkit da organização AWS — material auxiliar](https://github.com/aws/agent-toolkit-for-aws/blob/main/skills/specialized-skills/serverless-skills/aws-lambda-microvms/SKILL.md).
- [Relato independente sobre Docker](https://awsteele.com/blog/2026/06/23/some-notes-on-lambda-microvms.html).
- [Experimento de terceiro — Sealant PR 247](https://github.com/sealant-sh/sealant/pull/247).
- [Pricing Lambda](https://aws.amazon.com/lambda/pricing/).

## Answer

Aceito pelo Operador em 2026-11-20. Detalhe e evidência no [relatório](../research/lambda-proof-results.md),
com [avaliação por critério](../research/lambda-proof-assessment.json) sobre a
[rubrica v1](../research/lambda-proof-rubric.json).

**Sim, no perfil testado.** Em `us-east-1`, ARM64, baseline 1 GB / 0,5 vCPU com pico de 4 GB / 2 vCPU e
`additionalOsCapabilities: ["ALL"]`:

- **Docker: funciona.** `dockerd` iniciado no hook `/run`, build, run com bind mount, volume e porta,
  Compose com DNS entre serviços, e Testcontainers com Ryuk e PostgreSQL. Sem suporte documentado da AWS.
- **Transporte: funciona.** SSH sobre WebSocket pelo `HTTP_INGRESS` com componentes prontos (`websocat`
  e `wstunnel`), token do serviço por porta mais chave de sessão; streaming, exit code, interrupção e
  arquivos binários íntegros a cerca de 4 MB/s. Revisor somente leitura imposto pelo guest.
- **Vida limitada e Git: funciona.** Cessação confirmada por `GetMicrovm`; encerramento no tempo máximo
  com o hook de término chamado antes; gate de preservação recusando os seis casos sujos; reconstrução
  em outra MicroVM a partir do commit remoto; perda antes do push detectável.

**Limites e diferenças frente ao MVP que a consolidação precisa tratar:**

- Queda do canal não encerra o processo remoto; token vencido não derruba conexão aberta.
- Saída pública sem filtro de destinos (relaxamento que exige aprovação); UDP e IPv6 de saída indisponíveis.
- Portas locais do guest, inclusive a dos hooks, ficam ao alcance do revisor.
- Quota da conta de 8 GB de memória alocada; disco de 8 GB neste tamanho; sem logs de runtime sem
  execution role.
- Ressalvas: ociosidade sem keepalive e conexões além de 38 min não medidas.

**Não provado aqui:** harness e continuidade do agente entre boots
([ticket 09](09-agent-continuity-on-lambda-proof.md)), suspend/resume, oito horas, carga sustentada,
repositório real. Não é aceite da fábrica nem homologação de produção.

**Custo e recursos.** 5 MicroVMs, 1,12 MicroVM-hora, 2 builds; estimativa abaixo de US$ 1 do teto de
US$ 20; leitura do Cost Explorer pendente. Por decisão do Operador, imagens, roles, bucket e
repositório sintético ficam retidos para o ticket 09, que herda o cleanup; nenhuma MicroVM ativa.

## Comments

- Aberto como próximo passo pós-MVP; sem execução ou recursos AWS criados nesta sessão.
- 2026-11-20: reivindicado pelo Operador (sessão Claude Code); branch `docs/v2-lambda-prototype`, worktree `.worktrees/v2-lambda-prototype/`, destino `main`. Primeira etapa: revalidação documental e de preços, sem recursos AWS.
- 2026-11-20: [plano de execução](../research/lambda-microvms-execution-plan.md) autorizado e [rubrica v1](../research/lambda-proof-rubric.json) aprovada pelo Operador. Prova sem harness; a continuidade do agente foi para o [ticket 09](09-agent-continuity-on-lambda-proof.md). Roles, bucket e repositório sintético criados; nenhuma MicroVM ainda.
- 2026-11-20: prova executada e aceita pelo Operador; resolvido. Cleanup adiado por decisão do Operador e transferido ao ticket 09.
