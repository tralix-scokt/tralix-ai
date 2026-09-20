import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm";

const chat = document.getElementById("chat");
const input = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");

const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const modelStatus = document.getElementById("modelStatus");
const welcome = document.getElementById("welcome");

let engine = null;
let conversation = [];


// --------------------------------------------------
// TRALIX LOCAL AI MODEL
// --------------------------------------------------

const MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";


// --------------------------------------------------
// UI STATUS
// --------------------------------------------------

function setStatus(text, online = false) {
  statusText.textContent = text;

  if (online) {
    statusDot.style.background = "#00ff9d";
    statusDot.style.boxShadow = "0 0 12px #00ff9d";
  } else {
    statusDot.style.background = "#ffaa00";
    statusDot.style.boxShadow = "0 0 12px #ffaa00";
  }
}


// --------------------------------------------------
// LOAD LOCAL AI
// --------------------------------------------------

async function loadAI() {

  try {

    setStatus("LOADING AI");

    modelStatus.textContent =
      "Downloading the TRALIX AI model. This may take some time the first time.";

    engine = await CreateMLCEngine(
      MODEL,
      {
        initProgressCallback: (progress) => {

          if (progress?.text) {
            modelStatus.textContent = progress.text;
          }

        }
      }
    );

    setStatus("ONLINE", true);

    modelStatus.textContent =
      "TRALIX is ready. The AI is running locally on this device.";

    input.disabled = false;
    sendButton.disabled = false;

    input.focus();

  } catch (error) {

    console.error("TRALIX AI failed to load:", error);

    setStatus("AI ERROR");

    modelStatus.textContent =
      "TRALIX could not start the local AI. Your browser/device may not support WebGPU.";

  }

}


// --------------------------------------------------
// ADD MESSAGE
// --------------------------------------------------

function addMessage(role, text) {

  const message = document.createElement("div");

  message.className = `message ${role}`;

  const content = document.createElement("div");

  content.className = "message-content";

  content.textContent = text;

  message.appendChild(content);

  chat.appendChild(message);

  chat.scrollTop = chat.scrollHeight;

  return content;

}


// --------------------------------------------------
// SEND MESSAGE
// --------------------------------------------------

async function sendMessage() {

  const message = input.value.trim();

  if (!message || !engine) {
    return;
  }

  input.value = "";

  input.style.height = "auto";

  sendButton.disabled = true;

  input.disabled = true;


  // Remove welcome screen after first message

  if (welcome) {
    welcome.style.display = "none";
  }


  // Show user message

  addMessage("user", message);


  // Add to conversation

  conversation.push({
    role: "user",
    content: message
  });


  // AI response placeholder

  const aiMessage =
    addMessage("ai", "TRALIX is thinking...");


  try {

    const messages = [

      {
        role: "system",

        content:
          "You are TRALIX AI, a friendly, intelligent and helpful AI assistant. " +
          "Give clear and useful answers. " +
          "Be honest when you do not know something. " +
          "Do not invent facts. " +
          "You are running locally in the user's browser."
      },

      ...conversation

    ];


    const response =
      await engine.chat.completions.create({

        messages,

        temperature: 0.7,

        max_tokens: 512

      });


    const reply =
      response.choices?.[0]?.message?.content ||
      "I could not generate a response.";


    aiMessage.textContent = reply;


    conversation.push({

      role: "assistant",

      content: reply

    });


  } catch (error) {

    console.error("TRALIX response error:", error);

    aiMessage.textContent =
      "TRALIX encountered an error while generating the response.";

  }


  sendButton.disabled = false;

  input.disabled = false;

  input.focus();

}


// --------------------------------------------------
// BUTTON
// --------------------------------------------------

sendButton.addEventListener(
  "click",
  sendMessage
);


// --------------------------------------------------
// ENTER TO SEND
// --------------------------------------------------

input.addEventListener(
  "keydown",
  function(event) {

    if (
      event.key === "Enter" &&
      !event.shiftKey
    ) {

      event.preventDefault();

      sendMessage();

    }

  }
);


// --------------------------------------------------
// AUTO RESIZE TEXTBOX
// --------------------------------------------------

input.addEventListener(
  "input",
  function() {

    input.style.height = "auto";

    input.style.height =
      Math.min(input.scrollHeight, 150) + "px";

  }
);


// --------------------------------------------------
// START TRALIX
// --------------------------------------------------

loadAI();