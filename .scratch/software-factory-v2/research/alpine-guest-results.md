# Guest Alpine em Lambda MicroVMs — resultado da prova

Data: 2026-11-21. Ticket: [Validar o guest Alpine com o ambiente declarado em Lambda MicroVMs](../issues/10-alpine-guest-on-lambda-proof.md).
[Plano autorizado](alpine-guest-execution-plan.md), [rubrica v1](alpine-guest-rubric.json),
[avaliação por critério](alpine-guest-assessment.json), [evidência sanitizada](alpine-guest-evidence.json).

**Estado: aceito pelo Operador em 2026-11-21; cleanup concluído e verificado.**

**Resposta: sim, no perfil testado.** Uma imagem de MicroVM construída a partir de Alpine por um
`Dockerfile` fixo, montado dos valores de um `.factory/environment.yaml` de esquema v1, inicia com
Docker, SSH e o ambiente declarado funcionando. Os dez critérios foram aprovados.

**Alcance.** `us-east-1`, ARM64, base gerenciada `al2023-1` versão 3, container da aplicação em Alpine
3.23.8, baseline 1 GB / 0,5 vCPU com pico de 4 GB / 2 vCPU, `additionalOsCapabilities: ["ALL"]`,
`HTTP_INGRESS` e `INTERNET_EGRESS`, sem execution role, declaração e projeto sintéticos, sem harness e
sem modelo. Uma campanha: uma imagem, duas MicroVMs. Não é aceite da fábrica, homologação de produção
nem suporte oficial da AWS a Docker.

## Resultado por critério

| Critério | Resultado | Observação |
| --- | --- | --- |
| A1 build | approved | O validador de produção da declaração aceitou a declaração sintética e o gerador montou o `Dockerfile` (5 passos) só com os pares `nome=versão`; as referências de imagem vão num arquivo de dados. Uma declaração com comando no nome do pacote foi recusada no host, antes de qualquer build. Imagem em `CREATED` 2 min 10 s depois do pedido. |
| A2 apk exato | approved | No guest: `openjdk21-jdk-21.0.13.1_p2-r0` e `maven-3.9.11-r0`, iguais à declaração, vindos só de `main` e `community` do v3.23. Declaração negativa (`maven=3.9.11-r99`): build `FAILED` em 53 s, imagem `CREATE_FAILED` sem versão ativa, nenhuma outra versão instalada. |
| A3 boot | approved | No hook `/ready` do build e no início do hook `/run`, o único processo era o agente dos hooks: sem `dockerd` nem `sshd` no snapshot. Depois do `/run`: `dockerd` 29.5.2, `overlayfs`, cgroup v2, `hello-world` com exit 0, nas duas MicroVMs. |
| A4 ssh | approved | OpenSSH 10.2 do Alpine atrás do `websocat` empacotado pelo Alpine. Comando remoto devolveu stdout, stderr e exit 37; arquivo de 8 MiB foi e voltou com o mesmo sha256. Host key criada no boot, diferente em cada MicroVM. |
| A5 digest | approved | `docker pull` por digest no boot em menos de 1 s; `RepoDigests` igual ao declarado; `docker run` da referência com exit 0. Digest inexistente: pull com exit 1 e nenhuma imagem no lugar. |
| A6 compose | approved | Compose 2.40.3 do Alpine: o cliente resolveu `web` pelo nome e recebeu a resposta; depois do `down`, zero containers, redes e volumes. |
| A7 testcontainers | approved | `mvn test` com exit 0 sobre o OpenJDK 21 do Alpine (musl, aarch64): PostgreSQL 17 e Ryuk 0.12.0 vivos durante o teste, um teste aprovado, nenhum container 20 s depois. |
| P1 perfil | approved | Ver "Perfil medido". |
| C1 custo | approved | 2 pedidos de build de 6; 2 MicroVMs, cerca de 320 s somados (0,09 h de 5 h); estimativa abaixo de US$ 0,10 de US$ 10. Cost Explorer lido em 2026-11-21: ainda sem valor para o dia, o faturamento atrasa. |
| C2 cleanup | approved | Inventário depois da remoção: nenhuma imagem, MicroVM ativa, log group, role ou recurso com a tag do experimento; bucket inexistente; chaves, tokens e ferramentas locais apagados. Evidência preservada antes. |

## Perfil medido

- Guest: Alpine 3.23.8, musl, kernel `6.1.166-24.303.amzn2023` (o da base gerenciada, não o do Alpine).
- 2 vCPU e 4 GB visíveis; raiz de 7,8 GB com 6,4 GB livres depois do boot e 5,9 GB depois dos testes.
- Imagem do container: 698 MiB em 98 pacotes.
- Docker 29.5.2 (API 1.54), storage driver `overlayfs`, runtime `runc`; Compose 2.40.3; OpenSSH 10.2p1;
  `websocat` 1.14.0.
- `RunMicrovm` até SSH utilizável: 7,0 s e 7,7 s. `dockerd` pronto 19 s depois do início do hook no
  primeiro boot da imagem e 6 s no segundo. No segundo, boot completo com pull em 9,4 s.

## Achados para a implementação

1. **A causa da falha de build não está na API.** `stateReason` diz só "The container image build
   failed."; a linha do `apk` com o pacote e a versão recusados está no log de build do CloudWatch. Para
   cumprir "impedimento visível com causa", o adapter precisa ler esse log.
2. **Cada pedido de build gerou dois registros de build**, um por geração de chip (Graviton 3 e 4). O
   efeito disso na cobrança não foi medido.
3. **Digest inexistente aparece como `401 Unauthorized`** do registro público, não como "não
   encontrado". A falha é visível, mas a mensagem engana.
4. **O storage driver é `overlayfs`**, diferente do `vfs` do guest do MVP.
5. **Os pacotes do molde não foram fixados por versão** nesta prova (Docker, Compose, OpenSSH,
   `websocat`, Git, Python, Bash). O pin da release terá de fixá-los, e o mirror do Alpine só guarda o
   build atual de cada pacote: isso vale para o molde tanto quanto para a declaração.
6. **A conta do usuário precisa estar desbloqueada para o `sshd`** do Alpine (`*` no lugar de `!` no
   `shadow`); o molde já faz isso.
7. As ações IAM do rascunho da revalidação bastaram, sem recusa.

## Não provado aqui

Reuso de imagem por chave (repositório, hash, pin), que é lógica do adapter; x86_64; papéis Builder e
revisor, ociosidade e reconexão sobre Alpine (provados em Amazon Linux 2023, não repetidos); imagens
embutidas na imagem de MicroVM; registros privados; repositório real; carga sustentada.

## Cleanup

Feito em 2026-11-21 pelo helper de finalização: cessação confirmada pela API, evidência sanitizada
gravada e conferida, avaliação registrada e só então a remoção, com a identidade base da conta.

- Removidos e verificados: imagens `sfv2alpine-pos` e `sfv2alpine-neg` (pelo ARN), seus log groups, o
  bucket de artefatos, as roles `sfv2alpine-operator` e `sfv2alpine-build`, a chave de sessão, os
  tokens e o cliente do túnel locais.
- Retido de propósito, só local: evidência bruta em `/home/sanmoo/software-factory-test/v2-alpine-guest/`.
- Continua existindo: a retenção mínima do armazenamento de imagem que o serviço cobra após a remoção,
  e o código descartável na branch local `prototype/v2-alpine-guest`, não publicada.
