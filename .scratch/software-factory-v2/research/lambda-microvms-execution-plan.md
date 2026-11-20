# Lambda MicroVMs — plano de execução da prova (proposta para autorização)

Data: 2026-11-20. Ticket: [Validar Docker e transporte em Lambda MicroVMs](../issues/02-lambda-microvms-prototype.md).
Base factual: [revalidação documental e de preços](lambda-microvms-docs-revalidation.md).

**Estado: autorizado pelo Operador em 2026-11-20**, com os valores da seção "Autorização registrada".
A tabela "Autorização pedida" abaixo é a proposta original e fica como histórico; onde divergem, vale
a seção "Autorização registrada". A rubrica ainda precisa de aprovação antes do primeiro build.

## Autorização registrada

Respostas do Operador na sessão de 2026-11-20:

- Conta: a que a AWS CLI local usa hoje. Preflight sem custo feito nela (identidade, quotas, imagens base).
- Identidade: autorizado criar uma role com política mínima para a prova; a prova roda assumindo essa role.
- Região `us-east-1`. Arquitetura: somente ARM64, sem smoke x86.
- Tamanho: baseline 1 GB / 0,5 vCPU, pico 4 GB / 2 vCPU, disco máximo 16 GB, em todas as fases. Se o disco
  ou a memória não bastarem, registrar como achado e voltar ao Operador antes de subir de tamanho.
- Teto de custo: US$ 20, com parada obrigatória ao estimar US$ 15.
- Tetos de uso: 20 MicroVM-horas, 12 builds de imagem, `maximumDurationInSeconds` de no máximo 3600,
  prazo de 5 dias corridos (até 2026-11-25), cleanup ao final.
- Repositório sintético privado no GitHub com deploy key própria: autorizado, apagado no cleanup.
- Achados do preflight: quota de memória ARM alocada da conta é 8 GB (no máximo duas MicroVMs deste
  tamanho ao mesmo tempo); conexões simultâneas por MicroVM de 2 vCPU: 16, abaixo do piso documentado.

## O que a documentação já decidiu

- O teto de 8 horas por MicroVM está confirmado e inclui o tempo suspenso.
- Docker não tem suporte documentado; o `dockerd` rodaria aninhado no container da aplicação.
  Testcontainers com Ryuk não aparece em fonte alguma.
- SSH sobre WebSocket pelo `HTTP_INGRESS` não foi demonstrado em lugar nenhum. O acesso usa um token
  próprio de no máximo 60 minutos, não SigV4, e não há duração máxima de WebSocket publicada.
- São Paulo não tem preço de MicroVM; a prova precisa de outra região.

Portanto as duas perguntas centrais do ticket (Docker e transporte) só se respondem por experimento.

## Autorização pedida

| Item | Proposta |
| --- | --- |
| Conta AWS | A indicar pelo Operador. Não usar conta com cargas de produção. |
| Identidade | Um principal dedicado ao teste, com a política mínima rascunhada na seção 6 da revalidação. O Operador o cria (ou autoriza a criação a partir de um perfil administrativo); credenciais nunca são lidas, copiadas ou impressas por mim. |
| Região | `us-east-1` (menor preço, quotas maiores, x86 disponível). |
| Arquitetura | ARM64 em toda a prova (padrão do serviço e a única com relatos de Docker). Um smoke x86 no fim, se sobrar orçamento. |
| Tamanho | Baseline 2 GB / 1 vCPU com pico de 8 GB / 4 vCPU nas fases 1 e 3; baseline 8 GB / 4 vCPU só na fase 2 (Docker e Testcontainers). |
| Teto de custo | US$ 60, medido pela minha própria contabilidade de segundos de MicroVM, builds e GB (a fatura chega com atraso). Parada obrigatória ao estimar US$ 45. |
| Tetos de uso | 20 MicroVM-horas, 12 builds de imagem, 3 MicroVMs simultâneas, `maximumDurationInSeconds` de no máximo 3600 em toda execução. |
| Prazo | 5 dias corridos a partir da autorização; ao fim, cleanup mesmo com fases incompletas. |
| Repositório Git | Um repositório sintético privado no GitHub, criado para a prova e apagado no cleanup, com uma deploy key de escrita só para ele. Nenhum código da fábrica ou do piloto entra no guest. |
| `SHELL_INGRESS` | Não usar. Se a depuração travar sem ele, volto a pedir. |
| VPC, NAT, endpoints, trail de CloudTrail | Fora do escopo: custo fixo e não necessários com `INTERNET_EGRESS` e `HTTP_INGRESS`. |
| Host local | Instalar `wstunnel` (ou `websocat`) só no diretório da prova, sem serviço de sistema. |

## Fases

Cada fase termina com evidência gravada ou recusa explícita. Falha de uma fase não é contornada por
troca de serviço ou de arquitetura: é resultado, e volta ao Operador.

0. **Preflight, sem custo.** Identidade ativa, quotas efetivas da conta (contas novas têm quota
   reduzida), base images gerenciadas e arquiteturas oferecidas, versão da CLI. Rubrica aprovada antes
   de qualquer build.
1. **Imagem e ciclo de vida mínimo.** Build de uma imagem mínima, `run`, leitura de estado, `terminate`
   e confirmação por polling de `TERMINATED`. Mede: capabilities efetivas, cgroups, disco, tempo de
   build e de boot, latência entre pedido e cessação, comportamento ao atingir a duração máxima.
2. **Docker.** `dockerd` iniciado no hook `/run` (não no snapshot de build). `docker info`, build, run,
   Compose com rede e DNS, bind mounts, volumes, port mapping, DNS e UDP dos containers. Depois um
   projeto sintético Java com Testcontainers e Ryuk: criação, comunicação e cleanup reais.
3. **Transporte.** `sshd` no guest atrás de um túnel WebSocket pelo `HTTP_INGRESS`. Host key e chave de
   sessão efêmeras entregues por `runHookPayload`. Mede: streaming de stdout/stderr, exit code, arquivo
   binário, throughput, ociosidade, expiração do token com conexão aberta, desconexão e reconexão,
   interrupção. Dois usuários no guest: Builder e revisor somente leitura, com tentativas de bypass por
   shell, SFTP, port forwarding e socket do Docker.
4. **Vida limitada, Git e recuperação.** Gate de preservação (untracked, alterações, stash, commit sem
   push, remoto indisponível, ref de acompanhamento desatualizada). Troca planejada de boot com duração
   reduzida, cessação confirmada e reconstrução em outra MicroVM a partir do mesmo commit remoto. Falha
   injetada antes do push, com perda reportada.
5. **Rede.** O que o guest alcança pelo `INTERNET_EGRESS`: link-local e metadados, endpoints internos,
   outras MicroVMs. Sem execution role, para não haver credencial AWS no guest.
6. **Cleanup e relatório.** Inventário de tudo o que foi criado, remoção na ordem MicroVMs → versões →
   imagens → logs → S3 → roles → repositório e deploy key, com verificação de cada remoção. Custo real
   lido no Cost Explorer, com a data da leitura. A retenção mínima de uma semana do armazenamento de
   imagem continua cobrando após o cleanup; o valor entra no relatório.

## Regras de parada

- Estimativa acumulada em US$ 45, qualquer teto de uso atingido ou prazo vencido: parar e ir ao cleanup.
- Nenhuma MicroVM fica viva entre sessões de trabalho; toda sessão termina com `list-microvms` sem
  itens fora de `TERMINATED`.
- `InsufficientCapacityException`, quota insuficiente ou recusa de permissão: registrar e voltar ao
  Operador, sem tentar outra região, conta ou permissão mais ampla.
- Se o túnel SSH não atravessar o `HTTP_INGRESS` com componentes prontos: registrar o bloqueio. Não
  construir servidor exec próprio.

## Evidência e integração

- Rubrica por propriedade no formato dos [guardrails de ensaios](../../../docs/agents/experiment-proofs.md),
  aprovada pelo Operador antes da fase 1. Cada cenário recebe: funciona no perfil testado, falha
  conhecida ou indeterminado, com causa, limite e fonte.
- Código descartável (Dockerfiles, hooks, scripts) fica na branch `prototype/v2-lambda-microvms`, nunca
  integrada. Para a `main` vão só o relatório, a rubrica e os registros sanitizados.
- Registros não contêm tokens, chaves, IDs de conta ou conteúdo de `runHookPayload`.

## Estimativa

Referência da revalidação para 20 horas no maior tamanho, 10 builds e 20 GB-mês em ARM, `us-east-1`:
piso US$ 17, planejamento US$ 24, teto US$ 47. Com o tamanho menor nas fases 1 e 3, o esperado fica
abaixo do cenário de planejamento. A maior incerteza é como o uso acima do baseline é cobrado; a fase 1
mede isso em uma execução curta antes das fases caras.
