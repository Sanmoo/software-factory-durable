# 32: Distribuir uma release autocontida e verificável

**What to build:** O operador extrai uma release e executa a Factory sem compilar TypeScript nem instalar dependências por instalação ou Trabalho. Manifesto e diagnóstico identificam exatamente o conjunto distribuído e seus pré-requisitos.

**Blocked by:** [04: Diagnosticar o acesso GitHub pela identidade da Factory](04-github-app-access-diagnostics.md); [05: Executar um worker SDK com ferramentas confinadas e saída protegida](05-confined-sdk-worker-and-protected-output.md); [06: Executar testes Docker reais no perfil distribuível](06-real-docker-tests-on-supported-profile.md)

**Status:** resolved

## Acceptance criteria

- [x] Artefato inclui JavaScript emitido, dependências runtime do lockfile, Node privado, pacote próprio de skills e assets prontos, sem bundler/runner TypeScript/framework operacional novo por conveniência.
- [x] Manifesto fixa versões/integridades de Node/Pi/Durable/SDK/SQLite real e binding/Gondolin/QEMU/helpers/kernel/initramfs/Alpine/pacotes, perfil/ferramentas/skills/protocolo/formatos/limites e host usado nas provas.
- [x] Build registra TypeScript/npm, lockfile e checker arquitetural/configuração/fixtures, preservando créditos/licenças aplicáveis; instrumentos dev não são exigidos no host operador.
- [x] Instalação mantém raiz canônica, releases imutáveis selecionadas explicitamente, assets preservados enquanto dependentes, configuração sem segredos e áreas privadas para credenciais/dados/ambientes/run.
- [x] Setup repetido não sobrescreve dados/config/credenciais, não instala dependências por instalação/Trabalho, não inicia Ticket e não usa sudo; dependências administrativas e KVM funcional são diagnosticadas sem fallback TCG/krun.
- [x] Primeiro plano e serviço systemd opcional explicitamente solicitado usam o mesmo lock estável; systemd dos ambientes é requisito nos dois modos e workers não recebem administração host.
- [x] Prova de extração/setup/diagnóstico em instalação limpa e repetida comprova artefato autocontido e integridades; paths/FS incompatíveis falham explicitamente, sem prometer relocação livre.
- [x] Empacotamento não afirma cobertura funcional de features ainda não integradas; qualificação posterior usa a composição final e não apenas checksums ou sucesso de build.

## Referências e validação

- Autoridade: [spec técnica aprovada](../../software-factory/spec.md), seções 6.3, 7.4, 11.1, 13.4, 14; [PRD](../../software-factory/prd.md) e decisões canônicas vinculadas pela spec.
- Cenários: V-02, V-03, V-16 da [matriz de aceite](../../software-factory/acceptance-and-incremental-plan.md); registrar subcasos, nível fiel, expectativa/observado, lacunas e evidências da composição efetivamente testada. Dublê não comprova fronteira substituída.
- Aplicar o gate de desenvolvimento da spec: arquitetura estática, compilação/typecheck, suíte local completa e evidências reais pertinentes à mudança, sem adiar a prova da fronteira alterada para a release.

## Autorização e limites

Publicação é planejamento aprovado, não autorização de construção, uso de host/credenciais/GitHub/modelos reais, injeção de falhas ou piloto. Obter autorização pertinente antes da execução. Não alterar decisões aprovadas silenciosamente; lacuna de desenho volta ao operador. Merge e avaliação humana não são delegados aos agentes.

## Answer

Resolvido em 2026-11-14: release autocontida e verificável (manifest de todos os bytes, closure de runtime exata, assets e packs reverificados, falha fechada sem manifest, raiz fixada por construção) e composição de produção sem relógio implícito. Gate local 993/0; verificação real r32-v2 com build, verify (0 violações), install, setup idempotente, doctor e recusa antes do storage. Evidência: `docs/evidence/32-self-contained-release.md`.
