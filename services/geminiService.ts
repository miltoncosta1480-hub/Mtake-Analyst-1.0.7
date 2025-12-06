
import { GoogleGenAI, Type } from "@google/genai";
import { MarketSnapshot, AnalysisResult, SignalType, NewsSource, PreMarketAnalysis, PostEntryAnalysis } from '../types';

// --- FALLBACK: ANÁLISE MATEMÁTICA (CASO A IA FALHE) ---
function fallbackHeuristicAnalysis(snapshot: MarketSnapshot, newsSummary: string): AnalysisResult {
  let score = 0;
  const reasons: string[] = [];
  const positive: string[] = [];
  const negative: string[] = [];

  const assets = snapshot.assets;
  
  const ewz = assets.find(a => a.symbol === 'EWZ');
  if (ewz) {
    if (ewz.changePercent > 0.5) { score += 3; positive.push(`EWZ subindo forte (${ewz.changePercent}%)`); }
    else if (ewz.changePercent < -0.5) { score -= 3; negative.push(`EWZ caindo forte (${ewz.changePercent}%)`); }
  }

  const spy = assets.find(a => a.symbol === 'SPY');
  if (spy) {
    if (spy.changePercent > 0.3) { score += 2; positive.push("S&P 500 em alta"); }
    else if (spy.changePercent < -0.3) { score -= 2; negative.push("S&P 500 em baixa"); }
  }

  const usd = assets.find(a => a.symbol === 'USD');
  const dxy = assets.find(a => a.symbol === 'UUP');

  if (usd) {
    if (usd.changePercent < -0.2) { score += 1.5; positive.push("Dólar (BRL) perdendo força"); }
    else if (usd.changePercent > 0.2) { score -= 1.5; negative.push("Dólar (BRL) ganhando força"); }
  }

  if (dxy) {
    if (dxy.changePercent < -0.1) { score += 1.5; positive.push("DXY (Global) em queda (Risk-On)"); }
    else if (dxy.changePercent > 0.1) { score -= 1.5; negative.push("DXY (Global) em alta (Risk-Off)"); }
  }

  let signal = SignalType.NEUTRO;
  let confidence = 50;
  let outlook = "Lateralidade (Aguardar)";
  let entry = "Aguardar rompimento";
  let takeProfit = "N/A";
  let stopLoss = "N/A";

  if (score >= 3) {
    signal = SignalType.COMPRA;
    confidence = Math.min(60 + (score * 5), 95);
    outlook = "Tendência de Alta";
    entry = "Comprar Pullback";
    takeProfit = "+150 a +300 pts";
    stopLoss = "-150 pts";
  } else if (score <= -3) {
    signal = SignalType.VENDA;
    confidence = Math.min(60 + (Math.abs(score) * 5), 95);
    outlook = "Tendência de Baixa";
    entry = "Vender Repique";
    takeProfit = "+150 a +300 pts";
    stopLoss = "-150 pts";
  }

  return {
    signal,
    confidence,
    reasoning: "⚠️ MODO DE CONTINGÊNCIA (IA Indisponível): Sinal gerado por algoritmo quantitativo baseado no fluxo de EWZ, SPY, Dólar e DXY.",
    technicalOutlook: outlook,
    entryZone: entry,
    takeProfit,
    stopLoss,
    positiveFactors: positive.length > 0 ? positive : ["Fluxo comprador leve"],
    negativeFactors: negative.length > 0 ? negative : ["Fluxo vendedor leve"],
    newsSummary: newsSummary || "Não foi possível carregar notícias detalhadas no modo offline.",
    newsSources: [],
    timestamp: new Date().toISOString(),
    provider: 'FALLBACK'
  };
}

async function fetchMarketNews(ai: GoogleGenAI): Promise<{ summary: string; sources: NewsSource[] }> {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: `
        Pesquise no site investing.com e principais portais financeiros do Brasil as notícias MAIS RECENTES (últimas horas) sobre:
        1. "Ibovespa hoje notícias" ou "Bolsa de Valores hoje"
        2. "Dólar Futuro (WDO) tendência hoje"
        3. "Petrobras e Vale notícias hoje"
        4. "Cenário Fiscal Brasil hoje" e "Campos Neto / Haddad hoje"

        Identifique fatos relevantes que podem impactar o WINFUT agora.
      `,
      config: { tools: [{ googleSearch: {} }] }
    });

    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const sources: NewsSource[] = chunks
      .filter(c => c.web?.uri && c.web?.title)
      .map(c => ({ title: c.web!.title!, uri: c.web!.uri! }))
      .filter((v, i, a) => a.findIndex(t => t.uri === v.uri) === i)
      .slice(0, 4);

    return {
      summary: response.text || "Sem notícias relevantes encontradas no momento.",
      sources
    };

  } catch (error) {
    console.warn("Aviso: Busca de notícias indisponível.", error);
    return { summary: "Notícias indisponíveis (Modo Numérico Puro).", sources: [] };
  }
}

// --- FUNÇÃO DE SINAL (DAY TRADE) ---
export const analyzeMarket = async (snapshot: MarketSnapshot, imageBase64?: string): Promise<AnalysisResult> => {
  let newsSummary = "Aguardando análise...";
  let newsSources: NewsSource[] = [];

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const newsData = await fetchMarketNews(ai);
    newsSummary = newsData.summary;
    newsSources = newsData.sources;

    const categories: Record<string, string[]> = {};
    snapshot.assets.forEach(a => {
      if (!categories[a.category]) categories[a.category] = [];
      const change = typeof a.changePercent === 'number' ? a.changePercent : 0;
      const sign = change > 0 ? '+' : '';
      categories[a.category].push(`${a.symbol}: ${sign}${change}%`);
    });

    const marketDataSummary = Object.entries(categories)
      .map(([cat, items]) => `### ${cat}:\n${items.join(', ')}`)
      .join('\n\n');

    const promptText = `
      Atue como um Trader Institucional Sênior.
      
      ## CONTEXTO DE NOTÍCIAS (CRÍTICO):
      "${newsSummary}"
      (ATENÇÃO: Se houver notícia de alto impacto contra o fluxo técnico, invalide o sinal ou diminua a confiança. CITE explicitamente no 'reasoning' como a notícia impactou sua decisão).

      ## DADOS REAIS (41 Ativos):
      ${marketDataSummary}

      **REGRAS DE OURO:**
      1. Compare DXY (UUP) vs USDBRL. Se ambos sobem = Venda WINFUT.
      2. Compare EWZ vs SPY. Se EWZ cai e SPY sobe = Venda WINFUT.

      ${imageBase64 ? '## ANÁLISE VISUAL: Analise o gráfico anexo para definir Stops e Alvos.' : '## ANÁLISE TÉCNICA: Estime níveis técnicos.'}
      
      Gere um sinal e setup completo (Entrada, Stop, Alvo).
    `;

    const parts: any[] = [{ text: promptText }];
    if (imageBase64) {
      const base64Data = imageBase64.split(',')[1] || imageBase64;
      parts.push({ inlineData: { mimeType: "image/png", data: base64Data } });
    }

    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: { parts: parts },
      config: {
        thinkingConfig: { thinkingBudget: 2048 }, 
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            signal: { type: Type.STRING, enum: [SignalType.COMPRA, SignalType.VENDA, SignalType.NEUTRO] },
            confidence: { type: Type.INTEGER },
            reasoning: { type: Type.STRING },
            technicalOutlook: { type: Type.STRING },
            entryZone: { type: Type.STRING },
            stopLoss: { type: Type.STRING },
            takeProfit: { type: Type.STRING },
            positiveFactors: { type: Type.ARRAY, items: { type: Type.STRING } },
            negativeFactors: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ["signal", "confidence", "reasoning", "technicalOutlook", "entryZone", "stopLoss", "takeProfit", "positiveFactors", "negativeFactors"]
        }
      }
    });

    const resultText = response.text;
    if (!resultText) throw new Error("Sem resposta da IA");
    const analysis = JSON.parse(resultText);

    return { ...analysis, newsSummary, newsSources, timestamp: new Date().toISOString(), provider: 'GEMINI' } as AnalysisResult;

  } catch (error) {
    return fallbackHeuristicAnalysis(snapshot, newsSummary);
  }
};

// --- FUNÇÃO PÓS-ENTRADA (GESTÃO DE RISCO) ---
export const analyzeTradeManagement = async (
  snapshot: MarketSnapshot, 
  direction: 'COMPRA' | 'VENDA', 
  imageBase64: string,
  previousAnalysis?: AnalysisResult | null
): Promise<PostEntryAnalysis> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const newsData = await fetchMarketNews(ai);

  const categories: Record<string, string[]> = {};
  snapshot.assets.forEach(a => {
    if (!categories[a.category]) categories[a.category] = [];
    const change = typeof a.changePercent === 'number' ? a.changePercent : 0;
    const sign = change > 0 ? '+' : '';
    categories[a.category].push(`${a.symbol}: ${sign}${change}%`);
  });
  const marketDataSummary = Object.entries(categories)
    .map(([cat, items]) => `### ${cat}:\n${items.join(', ')}`)
    .join('\n\n');

  const base64Data = imageBase64.split(',')[1] || imageBase64;

  // CONSTRUÇÃO DO CONTEXTO DETALHADO DO SINAL ANTERIOR
  let previousSignalContext = "NENHUM SINAL PRÉVIO GERADO PELO SISTEMA (O usuário está operando sem referência técnica do App).";
  
  if (previousAnalysis) {
    previousSignalContext = `
      ======================================================
      O SISTEMA JÁ HAVIA GERADO UM SETUP TÉCNICO COMPLETO:
      ======================================================
      - DIREÇÃO SUGERIDA: ${previousAnalysis.signal} (Confiança: ${previousAnalysis.confidence}%)
      
      PARÂMETROS DE REFERÊNCIA (USE ISTO PARA VALIDAR A LINHA VERDE):
      - Faixa/Ponto de Entrada Sugerido: "${previousAnalysis.entryZone}"
      - Stop Loss Sugerido: "${previousAnalysis.stopLoss}"
      - Alvo (Gain) Sugerido: "${previousAnalysis.takeProfit}"
      
      IMPORTANTE: O campo 'Faixa de Entrada' pode conter um intervalo (ex: 'Entre 128.000 e 128.500'). Interprete o texto inteligentemente.
    `;
  }

  const promptText = `
    Você é um RISK MANAGER Institucional Sênior. O usuário já está posicionado em uma operação de ${direction}.
    
    ## 1. COMPARAÇÃO COM O SINAL ANTERIOR (CRÍTICO):
    ${previousSignalContext}
    
    TAREFA DE VALIDANÇÃO:
    - Olhe para a imagem anexa. Encontre a LINHA VERDE (Entrada do usuário).
    - Compare a posição da LINHA VERDE com a "Faixa de Entrada Sugerida" acima.
    - Se a linha verde estiver dentro ou próxima da faixa/range sugerido (ex: sugeriu "161.200 a 161.300" e a linha está em 161.250), considere uma ENTRADA TÉCNICA VÁLIDA.
    - Se a linha verde estiver muito longe (entrada atrasada) ou contra a direção sugerida, penalize o score.

    ## 2. AUDITORIA GRÁFICA (VISÃO ATUAL):
    - Onde está o preço atual em relação à LINHA VERDE?
    - O preço está ameaçando a LINHA AMARELA (Stop)?
    
    ## 3. AUDITORIA DE FLUXO (41 ATIVOS AGORA):
    ${marketDataSummary}
    Notícias: "${newsData.summary}"

    ## VEREDITO DE GESTÃO:
    Cruze (Gráfico Atual + Fluxo Agora + Validação da Entrada Anterior).
    1. O fluxo Macro (EWZ, DXY) ainda apoia a direção ${direction}?
    2. O usuário obedeceu o setup do sistema?
    3. Vale a pena segurar?

    Gere um relatório tático.
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3-pro-preview",
    contents: { 
      parts: [
        { text: promptText },
        { inlineData: { mimeType: "image/png", data: base64Data } }
      ]
    },
    config: {
      thinkingConfig: { thinkingBudget: 2048 },
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          tradeStatus: { type: Type.STRING, enum: ['SAUDÁVEL', 'ALERTA', 'CRÍTICO'] },
          actionRecommendation: { type: Type.STRING, enum: ['SEGURAR', 'ZERAR', 'MOVER STOP', 'REALIZAR PARCIAL'] },
          macroAlignment: { type: Type.STRING, enum: ['A FAVOR', 'CONTRA', 'NEUTRO'] },
          analysisText: { type: Type.STRING, description: "Explicação cruzando a linha verde visual com o range de entrada do sinal anterior." },
          adjustmentSuggestion: { type: Type.STRING, description: "Sugestão tática usando os números do sinal anterior como referência." },
          score: { type: Type.INTEGER, description: "Nota de 0 a 100 para a saúde do trade" }
        },
        required: ["tradeStatus", "actionRecommendation", "macroAlignment", "analysisText", "adjustmentSuggestion", "score"]
      }
    }
  });

  const result = JSON.parse(response.text || "{}");
  return { ...result, timestamp: new Date().toISOString() };
};

// --- ANÁLISE PRÉ-MERCADO ---
export const generatePreMarketReport = async (snapshot: MarketSnapshot): Promise<PreMarketAnalysis> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  const newsResponse = await ai.models.generateContent({
    model: "gemini-3-pro-preview",
    contents: `
      Pesquise informações para o Morning Call da B3 de hoje:
      1. AGENDA ECONÔMICA (Horários de Payroll, FOMC).
      2. FLUXO ESTRANGEIRO NA B3 ONTEM.
      3. CONTEXTO TÉCNICO DE ONTEM (WINFUT).
    `,
    config: { tools: [{ googleSearch: {} }] }
  });

  const context = newsResponse.text || "Sem notícias.";
  
  const categories: Record<string, string[]> = {};
  snapshot.assets.forEach(a => {
    if (!categories[a.category]) categories[a.category] = [];
    const change = typeof a.changePercent === 'number' ? a.changePercent : 0;
    const sign = change > 0 ? '+' : '';
    categories[a.category].push(`${a.symbol}: ${sign}${change}%`);
  });

  const fullMarketData = Object.entries(categories)
    .map(([cat, items]) => `### ${cat}:\n${items.join(', ')}`)
    .join('\n\n');

  const response = await ai.models.generateContent({
    model: "gemini-3-pro-preview",
    contents: `
      Você é um Estrategista Institucional. Crie um Morning Call baseado no Playbook:
      
      CONTEXTO WEB: ${context}
      DADOS 41 ATIVOS: ${fullMarketData}
      
      Gere JSON estrito com os 5 pilares (Agenda, Fluxo, Correlacionados, Contexto Ontem, Viés).
    `,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          globalSentiment: { type: Type.STRING, enum: ['BULLISH', 'BEARISH', 'MIXED', 'NEUTRAL'] },
          openingBias: { type: Type.STRING },
          volatilitySchedule: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                time: { type: Type.STRING },
                event: { type: Type.STRING },
                impact: { type: Type.STRING, enum: ['ALTO', 'MÉDIO', 'BAIXO'] },
                action: { type: Type.STRING }
              }
            }
          },
          foreignFlow: { type: Type.STRING },
          correlations: {
            type: Type.OBJECT,
            properties: {
              sp500: { type: Type.STRING },
              dxy: { type: Type.STRING },
              ewz: { type: Type.STRING },
              treasuries: { type: Type.STRING }
            }
          },
          yesterdayContext: { type: Type.STRING },
          strategyPlan: { type: Type.STRING }
        },
        required: ["globalSentiment", "openingBias", "volatilitySchedule", "foreignFlow", "correlations", "yesterdayContext", "strategyPlan"]
      }
    }
  });

  const result = JSON.parse(response.text || "{}");
  return { ...result, timestamp: new Date().toISOString() };
};
