# Guest Alpine em Lambda MicroVMs — plano de execução da prova (proposta para autorização)

Data: 2026-11-21. Ticket: [Validar o guest Alpine com o ambiente declarado em Lambda MicroVMs](../issues/10-alpine-guest-on-lambda-proof.md).
Requisito em jogo: V2-27 da [spec da v2](../spec.md). Rubrica proposta: [rubrica v1](alpine-guest-rubric.json).

**Estado: autorizado pelo Operador em 2026-11-21**, como proposto na tabela "Autorização pedida":
conta da AWS CLI local, `us-east-1`, ARM64, roles e bucket da prova, sem repositório no GitHub; tetos de
US$ 10 (parada em US$ 7), 6 builds, 5 MicroVM-horas, 2 MicroVMs simultâneas, 1800 s por MicroVM, prazo
até 2026-11-24 e cleanup completo. [Rubrica v1](alpine-guest-rubric.json) aprovada
([registro](alpine-guest-rubric-approval.json)). A autorização das provas anteriores não vale aqui.

## O que já se sabe e o que falta

A [prova de infraestrutura](lambda-proof-results.md) mostrou Docker, Compose, Testcontainers e SSH sobre
WebSocket com o container da aplicação em Amazon Linux 2023. O build de imagem sobe uma MicroVM da base
gerenciada `al2023-1` e executa o `Dockerfile` enviado; o kernel é o dessa base, não o do Alpine. A
diferença a provar está toda no userland: musl, `apk`, o `dockerd` e o `sshd` empacotados pelo Alpine, e
o JDK sobre musl com Testcontainers.

## Autorização pedida

| Item | Proposta |
| --- | --- |
| Conta AWS | A que a AWS CLI local usa hoje, como nas provas anteriores. A confirmar pelo Operador. |
| Identidade | Criar as roles `sfv2alpine-operator` (política mínima, a prova roda assumindo-a) e `sfv2alpine-build` (leitura do artefato e logs de build). Credenciais nunca são lidas, copiadas ou impressas. |
| Região e arquitetura | `us-east-1`, somente ARM64. |
| Tamanho | Baseline 1 GB / 0,5 vCPU, pico 4 GB / 2 vCPU, `additionalOsCapabilities: ["ALL"]`, `HTTP_INGRESS` e `INTERNET_EGRESS`, sem execution role. Se disco ou memória não bastarem: achado, e volta ao Operador. |
| Teto de custo | US$ 10, com parada obrigatória ao estimar US$ 7. As duas provas anteriores somadas ficaram abaixo de US$ 2. |
| Tetos de uso | 6 builds de imagem, 5 MicroVM-horas, 2 MicroVMs simultâneas, `maximumDurationInSeconds` de no máximo 1800. |
| Prazo | 3 dias corridos (até 2026-11-24); ao fim, cleanup mesmo com critérios incompletos. |
| Outros recursos AWS | Um bucket S3 para o zip do build e os log groups do build. Sem VPC, NAT, ECR privado ou `SHELL_INGRESS`. |
| GitHub | Nenhum repositório. O projeto sintético vai ao guest por `scp`; Git e reconstrução já foram provados. |
| Host local | Cliente do túnel instalado só no diretório da prova, sem serviço de sistema. Evidência em `/home/sanmoo/software-factory-test/v2-alpine-guest/`. |

## Fases

Cada fase termina com evidência gravada ou recusa explícita. Falha não é contornada trocando a base, o
esquema da declaração ou a arquitetura: é resultado e volta ao Operador.

0. **Preflight, sem custo.** Identidade ativa, quotas, versão da base gerenciada, versões atuais dos
   pacotes no índice do Alpine v3.23 para ARM64 (para escrever a declaração com versões que existem),
   digest do `FROM` e da imagem declarada, componente de túnel disponível para musl ARM64. Checker da
   rubrica com a aprovação registrada.
1. **Build positivo (A1, A2).** O host valida a declaração sintética e gera o `Dockerfile` a partir de
   um molde fixo: `FROM` Alpine por digest, pacotes do molde (docker, compose, openssh, git, túnel) e os
   pares `nome=versão` declarados, instalados só de `main` e `community` do branch. Um build.
2. **Build negativo (A2).** A mesma declaração com uma versão inexistente. Um build, que deve falhar.
3. **Boot e Docker (A3, A5, P1).** Duas MicroVMs da imagem positiva: hook de início, `docker info`,
   `hello-world`, pull por digest no boot, digest inexistente.
4. **SSH (A4).** Comando com exit code e arquivo binário de ida e volta pelo túnel.
5. **Compose e Testcontainers (A6, A7).** Projeto Maven sintético com PostgreSQL e Ryuk sobre o JDK do
   Alpine.
6. **Finalização (C1, C2).** Pelo [helper de finalização](../../../scripts/agent-checks/finalize.mjs):
   cessação confirmada por `GetMicrovm`, evidência sanitizada gravada, avaliação por critério, e só
   então remoção de MicroVMs, imagens (pelo ARN), log groups, bucket e roles, cada uma verificada.

Folga prevista: até 4 builds além dos dois planejados, para corrigir erro do molde. Erro que exija
mudar a hipótese (outra base, comando livre, pacote fora dos repositórios do Alpine) não é corrigido:
é registrado.

## Regras de parada

- Estimativa em US$ 7, qualquer teto atingido ou prazo vencido: parar e ir à finalização.
- Nenhuma MicroVM viva entre sessões de trabalho; toda sessão termina com `list-microvms` sem itens
  fora de `TERMINATED`.
- Falta de capacidade, quota insuficiente ou recusa de permissão: registrar e voltar ao Operador, sem
  outra região, conta ou permissão mais ampla.
- Critério reprovado ou inconclusivo: registrado como tal. A decisão sobre a forma da declaração no
  perfil Lambda é do Operador.

## Evidência e integração

- Para a `main`: este plano, a rubrica com sua aprovação, o relatório, a avaliação por critério e a
  evidência sanitizada. Sem tokens, chaves, IDs de conta ou conteúdo de `runHookPayload`.
- Código descartável (molde, gerador, hooks, scripts): branch local `prototype/v2-alpine-guest`, nunca
  integrada nem publicada.
- A evidência bruta fica no diretório local da prova e só é apagada depois de conferida a cópia
  sanitizada.

## Pontos que dependem do preflight

- O componente de túnel no guest: a prova anterior usou binários prontos de `websocat` e `wstunnel`. No
  Alpine, usa-se o que existir empacotado ou como binário musl para ARM64; se nenhum servir sem comando
  livre no molde, A4 fica inconclusivo e o achado vai ao Operador.
- A declaração do MVP foi exercitada em x86_64; aqui é ARM64. Versão que exista num e não no outro é
  achado a registrar em A2.
