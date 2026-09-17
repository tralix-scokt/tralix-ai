const API_URL =
  "https://YOUR-TRALIX-WORKER.workers.dev/api/chat";

const chat = document.getElementById("chat");
const input = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");

let conversation = [];


/* ==============================
   ADD MESSAGE
============================== */

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


/* ==============================
   SEND MESSAGE
============================== */

async function sendMessage() {

  const message = input.value.trim();

  if (!message) return;

  input.value = "";

  input.style.height = "auto";

  sendButton.disabled = true;

  addMessage("user", message);

  conversation.push({
    role: "user",
    content: message
  });

  const aiMessage =
    addMessage("ai", "TRALIX is thinking...");


  try {

    const response = await fetch(API_URL, {

      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        message: message,
        history: conversation
      })

    });


    const data = await response.json();


    if (!response.ok) {

      throw new Error(
        data.error ||
        "TRALIX could not respond."
      );

    }


    aiMessage.textContent = data.reply;


    conversation.push({

      role: "assistant",

      content: data.reply

    });


  } catch (error) {

    console.error(error);

    aiMessage.textContent =
      "TRALIX could not connect to the AI server. Please check the API connection.";

  } finally {

    sendButton.disabled = false;

    input.focus();

  }

}


/* ==============================
   SEND BUTTON
============================== */

sendButton.addEventListener(
  "click",
  sendMessage
);


/* ==============================
   ENTER TO SEND
============================== */

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


/* ==============================
   AUTO RESIZE INPUT
============================== */

input.addEventListener(
  "input",
  function() {

    input.style.height = "auto";

    input.style.height =
      Math.min(
        input.scrollHeight,
        150
      ) + "px";

  }
);