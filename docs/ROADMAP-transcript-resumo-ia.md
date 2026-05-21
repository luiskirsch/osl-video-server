# Feature roadmap — Transcript + Resumo IA das sessões

**Status:** roadmap (não implementado)
**Origem:** feedback de profissional em 2026-05-20 ("plataforma boa, mas o Zoom faz isso e adoraria ter aqui")
**Prioridade:** MÉDIA — implementar quando tiver 30-50 clientes pagantes (custo + LGPD pesado pra estágio early)

---

## Caso de uso real (cliente real)

> *"Eu leio o resumo do Zoom **antes da próxima sessão** pra recuperar contexto. Às vezes esqueço um detalhezinho da semana passada — o resumo me lembra. E tem a parte de compromissos por pessoa: 'Gisele se comprometeu a estudar fibromialgia para semana que vem. Gisele ficou responsável de ter uma conversa com o marido sobre tal'. Isso é ouro."*

Profissional NÃO precisa de transcrição perfeita — aceita erros pequenos. Quer **preparação rápida pra próxima sessão**.

## Spec funcional

### Após cada sessão encerrada:

1. **Áudio** capturado durante a chamada (via LiveKit egress audio-only — já existe infra de gravação)
2. **Transcrição** assíncrona (Whisper API ou local)
3. **Resumo gerado por Claude:**
   - Parágrafo único de 3-5 frases ("o que foi discutido")
   - Lista de **tópicos por bloco temático** (relacionamento, sintoma X, medicação, etc)
   - Lista de **compromissos por pessoa** (paciente vai fazer X, profissional vai fazer Y)
   - Lista de **temas a retomar** na próxima
4. **Notificação** no painel: "Resumo da sessão de [paciente] disponível"
5. **UI no prontuário:** card "Resumo IA" na timeline da sessão, expansível, editável (profissional ajusta inaccuracies)
6. **Disponível na agenda da próxima sessão:** botão "Ler resumo da última" no card do paciente

### Após X sessões:

- Cross-session insights: "Padrões recorrentes mencionados pelo paciente nos últimos 3 encontros"
- Action items pendentes (que ficaram em aberto): "Paciente disse semana retrasada que ia conversar com marido — ainda não trouxe na conversa"

## Stack técnica proposta

```
LiveKit Egress (audio-only)
    ↓ S3/R2 (upload do .opus ou .mp3)
    ↓
Backend cron: a cada 1min, pega novos uploads
    ↓ Whisper API (Replicate / OpenAI / self-host)
    ↓ Texto
    ↓ Claude API (Haiku 4.5) com prompt estruturado
    ↓ JSON estruturado { summary, topics[], commitments[], followups[] }
    ↓ Firestore: therapy_session_summaries/{sessionId}
    ↓
Frontend: prontuário renderiza
```

## Custos estimados (sessão 50min)

| Item | Provider | Custo/sessão |
|---|---|---|
| Egress audio | LiveKit | ~$0.001 |
| Storage 30 dias | R2 | ~$0.0001 |
| Transcrição | OpenAI Whisper ($0.006/min) | $0.30 |
| Transcrição alt | Replicate (Whisper large-v3) | $0.10 |
| Transcrição alt 2 | Self-host Whisper local | $0 (CPU) ou ~$0.05 (GPU rented) |
| Resumo Claude Haiku 4.5 | input ~5k tokens + output ~500 | $0.005 + $0.0025 = $0.0075 |
| **Total ~$0.30-0.40 por sessão** |

A R$199/mês (plano profissional), profissional médio = 20-40 sessões/mês = R$ 6-16 de custo de IA por cliente. **Margem boa**.

## Bloqueadores legais (LGPD + CFP)

### Privacidade
- **E2EE atual quebra:** servidor hoje NÃO vê áudio. Pra transcrever, precisa ver. Decisão: o paciente OPTA IN explícito por sessão? Por padrão? Profissional opta?
- **Resolução CFP 11/2018** (psicólogos): obriga consentimento explícito pra gravação. Termo escrito assinado.
- **LGPD Art. 11:** dado de saúde mental é categoria sensível — exige consentimento específico, finalidade clara, prazo de retenção definido.

### Implementação legal sugerida
1. **Opt-in explícito por paciente** no termo do primeiro atendimento (checkbox "Aceito gravação + transcrição IA das sessões")
2. **Opt-in por sessão:** popup antes de iniciar — "Esta sessão será transcrita e resumida por IA. Profissional verá o resumo. Áudio será deletado após 30 dias. Consentir?"
3. **Profissional pode desligar:** toggle no perfil + por-sessão override
4. **Retenção:** áudio 30 dias, transcrição 90 dias, resumo permanente (parte do prontuário)
5. **Direito de remoção:** paciente pode requisitar exclusão a qualquer momento (LGPD Art. 18)
6. **Disclosure no perfil público:** profissional verificado mostra badge "Transcrição IA disponível, mediante consentimento"

## MVP mínimo (1-2 semanas)

**Fase 1 (escopo do MVP):**
- Toggle no perfil do profissional: "Habilitar transcrição IA das minhas sessões"
- Modal de consentimento ao iniciar sessão (paciente clica)
- LiveKit egress audio iniciado quando ambos consentem
- Backend: endpoint POST `/therapy/session/transcribe` (recebe sessionId, busca audio do storage, transcreve, salva)
- Worker async: processa fila a cada 5min
- Frontend: card "Resumo IA" no prontuário (apenas leitura, não-editável no MVP)
- Notificação push quando resumo fica pronto

**Fase 2 (pós-MVP):**
- Edição do resumo
- "Ler última sessão" na agenda
- Cross-session insights
- i18n PT/EN/ES

## Decisão pendente

Implementação **NÃO começou**. Reavaliar quando:
- Receita mensal cobre custo do dev (1-2 semanas de tempo do dono) + ~$50-100/mês de custos variáveis sem prejuízo
- Pelo menos 30 clientes ativos pra validar feature (não construir pra ninguém)
- Tem advogado / consultor LGPD pra revisar o termo de consentimento antes de produção

**Próxima ação quando reativar este roadmap:** revisar este doc, mudar status, criar branch `feature/session-transcript-ia`, começar pelo toggle no perfil + modal de consentimento.
