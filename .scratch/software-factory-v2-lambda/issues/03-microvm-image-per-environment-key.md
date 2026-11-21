# 03: Imagem de MicroVM por chave de ambiente (Preparar)

**What to build:** Um repositório com `.factory/environment.yaml` (esquema do MVP, sem mudança) tem sua imagem de MicroVM pronta antes do primeiro boot.
O adapter constrói uma imagem por (repositório, hash do arquivo, pin da release) com um `Dockerfile` fixo montado pelo host a partir dos
valores validados, partindo de Alpine, sem comandos livres. Trabalhos com a mesma chave reutilizam a imagem; repetir Preparar é
reconhecível. Falha de build é impedimento visível com causa.

A [prova do guest Alpine](../../software-factory-v2/research/alpine-guest-results.md) deixou três obrigações: ler a causa da falha no log
de build (a API devolve só um motivo genérico); fixar no pin da release as versões dos pacotes do molde; desbloquear a conta do usuário
para o `sshd`. O código descartável da prova está na branch `prototype/v2-alpine-guest` e serve de referência, não de implementação.

Requisitos da [spec da v2](../../software-factory-v2/spec.md): V2-27, V2-02 (Preparar), V2-33 (tags).

Testes automáticos usam um fake do serviço Lambda MicroVMs: o CI não tem conta AWS. Seguir `docs/agents/testing.md`; gate `npm run test:ci`.

**Blocked by:** 02

**Type:** task

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Preparar garante a imagem da chave (repositório, hash do arquivo, pin da release); segunda chamada com a mesma chave reutiliza, sem novo build.
- [ ] O `Dockerfile` é montado só pelo host a partir de valores validados; nenhum texto livre do repositório entra nele. Pacotes `apk` nas versões exatas declaradas; versões dos pacotes do molde fixadas no pin da release.
- [ ] Falha de build vira impedimento visível com a causa lida do log de build; sem fallback de imagem ou versão e sem retry implícito.
- [ ] Imagem e artefatos de build levam as tags de instalação e de Trabalho.
- [ ] A imagem contém o necessário para o hook de início (`dockerd`, `sshd`, conta de usuário desbloqueada); imagens Docker declaradas não são embutidas.
- [ ] Mudança do arquivo de ambiente ou do pin da release gera chave nova; Trabalhos em andamento continuam com a imagem com que começaram.
- [ ] Smoke em conta AWS real, no perfil de aceite (`us-east-1`, ARM64), com evidência registrada no `## Answer`. Exige autorização específica do Operador antes de rodar (conta, permissões, teto de consumo, prazo e cleanup), conforme `docs/agents/experiment-proofs.md`. Sem autorização, o critério fica desmarcado e declarado; nunca é dado por feito pelo fake.
