# 04: Boot Lambda: iniciar, canal, observar e parar

**What to build:** Um boot completo no Lambda, sem agente: iniciar uma MicroVM da imagem preparada, estabelecer o canal, clonar o commit de partida no
guest, rodar um comando, observar e parar. Iniciar é sempre um boot novo, nunca adoção de sobrevivente. Nenhum processo vem do snapshot:
`dockerd`, `sshd` e a host key nascem no hook de início; as imagens Docker declaradas são baixadas por digest a cada boot.

O canal é SSH transportado em WebSocket pelo `HTTP_INGRESS`, com componentes prontos; `SHELL_INGRESS` e servidor exec próprio não são
usados. Referência: branch `prototype/v2-lambda-microvms` e os [resultados da prova](../../software-factory-v2/research/lambda-proof-results.md).

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-02 (Iniciar, Observar, Parar), V2-09 (suspensão desligada), V2-10 (registro de boot), V2-20, V2-22, V2-24 (transporte), V2-25, V2-28, V2-34.

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 03

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Iniciar faz `RunMicrovm` com tags de instalação e de Trabalho, sem execution role, com a suspensão automática por ociosidade desligada, e só devolve sucesso com o canal estabelecido e o commit de partida clonado do `origin` no guest.
- [ ] Credenciais do transporte: chave SSH de sessão por boot gerada no host e entregue no payload do hook de início; host key gerada no boot e fixada pelo host; token do serviço por porta. Conexão com host key diferente da fixada é recusada.
- [ ] O adapter mantém keepalive no canal. Retirar acesso é fechar a conexão ou encerrar a MicroVM; o código não depende do vencimento do token para isso.
- [ ] Observar devolve a condição pelo serviço (`GetMicrovm`) e funciona sem o processo que criou o boot.
- [ ] Parar faz `TerminateMicrovm` e só confirma cessação quando o serviço confirma; não preserva disco. Cessação não confirmada é resultado indeterminado, nunca sucesso.
- [ ] Cada boot é registrado com identidade, motivo (início, troca planejada, perda ou fim), tamanho, início e fim.
- [ ] O boot usa `INTERNET_EGRESS` e o adapter declara a saída como capacidade: qualquer destino público IPv4 por TCP, sem mediação nem filtro; sem UDP e IPv6 de saída; sem VPC (V2-25).
- [ ] Cada boot começa sem caches e sem dados do Docker; as imagens Docker declaradas são baixadas por digest no início.
- [ ] Credenciais AWS ficam só no host; nada do host além do payload do hook e do que passa pelo canal chega ao guest.
- [ ] A evidência do guest é a que o host coleta pelo canal; o que não foi coletado antes de uma morte é declarado perdido.
- [ ] Smoke em conta AWS real, no perfil de aceite (`us-east-1`, ARM64), com evidência registrada no `## Answer`. Exige autorização específica do Operador antes de rodar (conta, permissões, teto de consumo, prazo e cleanup), conforme `docs/agents/experiment-proofs.md`. Sem autorização, o critério fica desmarcado e declarado; nunca é dado por feito pelo fake.
