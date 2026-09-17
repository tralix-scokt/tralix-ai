export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders
      });
    }

    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({
          error: "Only POST requests are allowed."
        }),
        {
          status: 405,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        }
      );
    }

    try {
      const body = await request.json();

      const message = body.message;
      const history = body.history || [];

      if (!message || typeof message !== "string") {
        return new Response(
          JSON.stringify({
            error: "A message is required."
          }),
          {
            status: 400,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
            }
          }
        );
      }

      const contents = history
        .filter(item =>
          item.role === "user" ||
          item.role === "assistant"
        )
        .map(item => ({
          role: item.role === "assistant"
            ? "model"
            : "user",
          parts: [
            {
              text: String(item.content)
            }
          ]
        }));

      if (
        contents.length === 0 ||
        contents[contents.length - 1].parts[0].text !== message
      ) {
        contents.push({
          role: "user",
          parts: [
            {
              text: message
            }
          ]
        });
      }

      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text:
                    "You are TRALIX AI, a friendly, intelligent, and helpful AI assistant. " +
                    "Give accurate answers, explain things clearly, and admit uncertainty. " +
                    "Do not claim to know information that you cannot verify."
                }
              ]
            },
            contents
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        return new Response(
          JSON.stringify({
            error: "Gemini API error.",
            details: data
          }),
          {
            status: response.status,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
            }
          }
        );
      }

      const reply =
        data.candidates?.[0]?.content?.parts
          ?.map(part => part.text || "")
          .join("") ||
        "I could not generate a response.";

      return new Response(
        JSON.stringify({
          reply
        }),
        {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        }
      );

    } catch (error) {
      return new Response(
        JSON.stringify({
          error: "The TRALIX server encountered an error."
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        }
      );
    }
  }
};