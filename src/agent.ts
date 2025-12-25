import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function analyzeEvent(
  question: string,
  outcomes: string[]
): Promise<number> {
  const prompt = `
    Analyze this Polymarket event:
    Question: "${question}"
    Possible outcomes: ${outcomes.join(", ")}
    Estimate the probability that the first outcome will occur (as a percentage).
  `;

  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });

    const text = response.choices[0]?.message?.content || "";
    
    // Simple percentage extraction
    const match = text.match(/(\d{1,3})%/);
    return match ? parseFloat(match[1]) / 100 : 0.5;
  } catch (error) {
    console.error("Error analyzing event with OpenAI:", error);
    return 0.5; // Default probability on error
  }
}

