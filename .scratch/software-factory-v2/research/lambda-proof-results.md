# Lambda MicroVMs — resultados da prova de infraestrutura

Data: 2026-11-20. Ticket: [Validar Docker e transporte em Lambda MicroVMs](../issues/02-lambda-microvms-prototype.md).
[Plano autorizado](lambda-microvms-execution-plan.md) · [rubrica v1](lambda-proof-rubric.json) ·
[aprovação](lambda-proof-rubric-approval.json) · [evidência sanitizada](lambda-proof-evidence.txt) ·
[avaliação por critério](lambda-proof-assessment.json).

**Alcance.** Vale só para o perfil testado: `us-east-1`, ARM64, base image `al2023-1` versão 3.1, baseline
1 GB / 0,5 vCPU com pico de 4 GB / 2 vCPU, `additionalOsCapabilities: ["ALL"]`, `HTTP_INGRESS` e
`INTERNET_EGRESS`, sem execution role, repositório sintético, sem harness. Não é aceite da fábrica,
homologação de produção nem suporte oficial da AWS: Docker continua sem menção na documentação.
A continuidade do agente entre boots é do [ticket 09](../issues/09-agent-continuity-on-lambda-proof.md).

## Resposta curta

Docker (incluindo Compose e Testcontainers com Ryuk) e SSH sobre WebSocket pelo `HTTP_INGRESS`
funcionam no perfil testado, com componentes prontos. A reconstrução a partir do Git remoto em outra
MicroVM funciona. Nenhum critério contratual falhou; dois ficaram com ressalva (T4 e T5) e as
diferenças frente ao MVP estão em "Achados para o desenho".

## Resultado por critério

| Critério | Resultado | Observação mínima |
| --- | --- | --- |
| L1 ciclo | funciona | `TerminateMicrovm` às 19:14:39,6; `TERMINATED` visível às 19:14:48, `terminatedAt` 19:14:41; endpoint parou de responder de imediato. Três términos pedidos: 4 a 8 s até `TERMINATED`. |
| L2 duração | funciona | Limites de 90 s, 150 s e 3600 s: término aos 92 s, 153 s e 3604 s, `stateReason` "MicroVM exceeded maximum lifetime.". O hook `/terminate` foi chamado antes e completou um `git push` nos dois casos em que havia repositório. |
| L3 perfil | medido | 2 vCPU e 4 GB visíveis no guest (o pico, não o baseline); raiz ext4 de 8 GB com 7,1 GB livres; kernel 6.1.166; root com todas as capabilities, seccomp desligado, `NoNewPrivs=1`; cgroup v2 gravável; overlay, mount e netns funcionam. Build de imagem: 2 min (mínima) e 3,5 min (completa). `RunMicrovm` até SSH utilizável: cerca de 7 s, mais ~25 s para o `dockerd`. |
| D1 daemon | funciona | Docker 25.0.18 iniciado no hook `/run`, overlay2 sobre ext4, cgroupfs v2; `hello-world` com exit 0. Exigiu o passo de aninhamento de cgroup do docker-in-docker. |
| D2 build/run | funciona | Build de três camadas; bind mount lido e escrito nos dois sentidos; volume nomeado; porta publicada respondeu HTTP. |
| D3 compose | funciona | Dois serviços, um construído; o cliente resolveu `web` por nome e leu a página; `down` sem resíduos. |
| D4 DNS | funciona, UDP bloqueado | Container resolve e alcança HTTPS sem `--dns` (resolvedor 169.254.53.53). UDP de saída para 8.8.8.8 falha por timeout, do guest e do container. |
| D5 Testcontainers | funciona | Teste JUnit com PostgreSQL 16: Ryuk 0.11.0 iniciou, teste aprovado em 31 s com dependências baixadas; 15 s depois, nenhum container nem rede do teste. Repetido com sucesso em uma segunda MicroVM. |
| D6 recursos | cabe | Após toda a bateria: 1,9 GB de disco usados de 7,8 GB; memória em uso de 0,2 GB ao final; o pico durante os testes não foi medido. O disco é de 8 GB, não os 16 GB documentados para este tamanho. |
| T1 túnel | funciona | SSH com `websocat` 1.14.2 e, separadamente, com `wstunnel` 11.1.0, autenticados pelo token do serviço por header e por chave ed25519 de sessão entregue em `runHookPayload`. Host key gerada no `/run`, distinta em cada MicroVM, obtida pelo endpoint autenticado e fixada em `known_hosts`. |
| T2 exec | funciona | stdout e stderr separados, chegando a cada segundo; exit codes 0 e 7 fiéis; `^C` em pty encerra o processo remoto. |
| T3 arquivos | funciona | 100 MB em cada sentido com SHA256 igual; 4,1 MB/s de subida e 4,3 MB/s de descida (o documentado para 2 vCPU é 4 MB/s sustentados). |
| T4 conexão | funciona, com ressalva | Conexão aberta sobreviveu 181 s com token de 60 s; conexão nova com token vencido: 403. Uma conexão com keepalive durou 37,6 min e só caiu com o fim da MicroVM. Queda do canal: o host vê exit 255; o processo remoto continuou vivo, com e sem pty (conferido 8 s depois; o processo com pty seguia vivo cerca de 3 min depois). Não medido: ociosidade sem keepalive e duração além de 38 min. |
| T5 papéis | funciona, com ressalva | Revisor: leitura sim; escrita, `git commit`, socket do Docker, `su`, SFTP de escrita e port forwarding recusados pelo guest. Controle: Builder trabalha e encaminha portas. Ressalva: o revisor alcança por loopback a porta dos hooks (9000) e a de diagnóstico. |
| T6 segredos | funciona | Revisor não lê a deploy key, a host key privada nem o ambiente do PID 1; container sem montagem não vê `/home` nem `/workspace`. Como previsto, o Builder com Docker monta e lê qualquer arquivo do guest. |
| G1 gate | funciona | Aceitou só o estado publicado; recusou untracked, modificado, stash, commit sem push, remoto indisponível e ref de acompanhamento desatualizada (ref local igual ao HEAD, `ls-remote` diferente). |
| G2 reconstrução | funciona | Segunda MicroVM criada depois: `/workspace` vazio, sem cache Maven nem imagens Docker; clone do SHA publicado, teste e Compose repetidos com sucesso. Ressalva de ordem: a primeira MicroVM ainda estava viva nesse momento; a sequência cessação → novo boot está em G3. |
| G3 troca | funciona | Commit WIP, push, gate OK, `TERMINATED` confirmado às 19:47:42; nova MicroVM pedida às 19:47:59 encontrou o mesmo SHA 36 s depois. |
| G4 perda | funciona | Duas MicroVMs morreram por tempo máximo com commit não publicado: a branch de trabalho no remoto ficou no último SHA publicado; o gate já recusava antes da morte. O hook de término publicou o commit perdido em uma ref de marcador, em ambos os casos. |
| N1 egress | caracterizado | IMDS responde (região, placement, tags) mas sem credenciais (`security-credentials` 404) e sem variáveis `AWS_*` de credencial; faixas privadas e 169.254.170.2 inalcançáveis; saída IPv4 pública sim, IPv6 não; container aninhado não alcança o IMDS. Sem filtragem de destinos: relaxamento frente à mediação do MVP. |
| N2 ingress | funciona | Sem token, com token inválido e com token vencido: 403. Token da porta 8080 usado na 9000: 403 "Access to port denied". |
| C1 custo | dentro dos tetos | 5 MicroVMs, 4.017 s somados (1,12 h de 20 h), 2 builds de 12. Compute estimado entre US$ 0,07 (baseline) e US$ 0,28 (pico); total estimado abaixo de US$ 1 de US$ 20. Leitura do Cost Explorer pendente (a fatura atrasa). |
| C2 cleanup | pendente | Nenhuma MicroVM ativa. Imagens, bucket, log groups, roles e repositório ainda existem, aguardando decisão do Operador. |

## Achados para o desenho

1. **O guest recebe o pico, não o baseline.** Com baseline de 1 GB o sistema já mostra 4 GB e 2 vCPU. O
   baseline define preço mínimo e quota, não o que o guest enxerga.
2. **Quota da conta: 8 GB de memória ARM alocada.** Duas MicroVMs deste tamanho ao mesmo tempo; mais
   que isso exige pedido de aumento.
3. **`ready` é obrigatório** quando qualquer hook de ciclo de vida está ligado. `CreateMicrovmImage` e
   `TagResource` não aceitam restrição por recurso em IAM.
4. **Nada de processo no snapshot.** `dockerd`, `sshd` e a host key nascem no hook `/run`; funcionou sem
   o problema de `/run` ausente relatado por terceiros.
5. **Hook de término é utilizável como rede de segurança.** Foi chamado no término pedido e no tempo
   máximo, com tempo para um push. A direção de não depender só dele continua correta: não foi testado
   com push lento, remoto indisponível ou falha do próprio serviço.
6. **Canal fechado não é processo encerrado.** O host precisa reconectar e consultar; e um comando
   órfão continua consumindo até alguém encerrá-lo.
7. **Token vencido não derruba conexão aberta.** A revogação de acesso depende de fechar a conexão ou
   encerrar a MicroVM, não do prazo do token.
8. **Isolamento do revisor depende do desenho do guest.** Usuário Unix sem grupo `docker` e `sshd` com
   forwarding negado bastaram no teste, mas portas locais (hooks) ficam ao alcance de qualquer usuário.
9. **Sem logs de runtime sem execution role**, e Run/Terminate não aparecem no CloudTrail por padrão:
   a evidência de ciclo de vida vem de `GetMicrovm`.
10. **Rede:** UDP e IPv6 de saída indisponíveis; sem allow-list de destinos no egress público.
11. **Divergências da documentação:** disco de 8 GB (documentado 16); 16 conexões simultâneas por
    MicroVM de 2 vCPU na quota (documentado piso de 150); `/sys` e cgroup graváveis.

## Não coberto

- Harness e modelo; continuidade de sessão do agente ([ticket 09](../issues/09-agent-continuity-on-lambda-proof.md)).
- Suspend/resume, x86, outros tamanhos, VPC, carga sustentada, MicroVMs de oito horas.
- Ociosidade sem keepalive e limite real de duração de um WebSocket.
- O perfil completo de um repositório real (o projeto sintético usa um container PostgreSQL).

## Intervenções e desvios

- Política da role da prova ampliada duas vezes para ações que não aceitam restrição por recurso
  (`CreateMicrovmImage` em `*`; `TagResource` em `*` condicionada à tag do experimento).
- Um token de acesso de 10 minutos, restrito à porta de diagnóstico de uma MicroVM já encerrada, foi
  impresso na saída de um comando da sessão; não consta de nenhum registro.
- A medição de conexão longa foi reiniciada uma vez (o primeiro laço foi morto por engano por um
  comando do próprio teste); o valor de 37,6 min é da segunda medição.

## Recursos existentes (para o cleanup)

AWS, `us-east-1`, tag `experiment=sf-v2-lambda-proof`: imagens `sfv2proof-min` e `sfv2proof-full` (uma
versão cada), bucket `sfv2proof-artifacts-<conta>-us-east-1`, log groups `/aws/lambda-microvms/sfv2proof-*`,
roles `sfv2proof-operator` e `sfv2proof-build`. GitHub: repositório privado `Sanmoo/sfv2proof-synthetic`
com uma deploy key. Local: `/home/sanmoo/software-factory-test/v2-lambda/` (chaves e evidência bruta).
Código descartável: branch `prototype/v2-lambda-microvms`, commit `e92157e`, não integrada.
