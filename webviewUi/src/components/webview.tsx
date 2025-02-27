/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Message {
  type: "user" | "bot";
  content: string;
  language?: string;
  alias?: string;
}

export interface ExtensionMessage {
  type: string;
  payload: any;
}

import {
  VSCodeProgressRing,
  VSCodeTextArea,
} from "@vscode/webview-ui-toolkit/react";
import { useEffect, useState } from "react";
import { codeBuddyMode, modelOptions } from "../constants/constant";
import AttachmentIcon from "./attachmentIcon";
import { BotMessage } from "./botMessage";
import { UserMessage } from "./personMessage";
import { ModelDropdown } from "./select";

const vsCode = (() => {
  if (typeof window !== "undefined" && "acquireVsCodeApi" in window) {
    return (window as any).acquireVsCodeApi();
  }
  // Fallback for non-VSCode environments
  return {
    postMessage: (message: any) => {
      console.log("Message to VS Code:", message);
    },
  };
})();

export const WebviewUI = () => {
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedCodeBuddyMode, setSelectedCodeBuddyMode] = useState("");
  const [userInput, setUserInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [isBotLoading, setIsBotLoading] = useState(false); // New state

  useEffect(() => {
    const messageHandler = (event: any) => {
      setIsBotLoading(true);
      const message = event.data;
      switch (message.type) {
        case "bot-response":
          setIsBotLoading(false); // Stop loading after receiving response
          setMessages((prevMessages) => [
            ...(prevMessages || []),
            {
              type: "bot",
              content: message.message,
              language: "Typescript",
            },
          ]);
          break;
        case "error":
          console.error("Extension error", message.payload);
          break;
        case "modelUpdate":
          setSelectedModel(message.payload.model);
          break;
        case "modeUpdate":
          setSelectedCodeBuddyMode(message.payload.model);
          break;
        default:
          console.warn("Unknown message type", message.type);
      }
    };
    window.addEventListener("message", messageHandler);
    return () => {
      window.removeEventListener("message", messageHandler);
    };
  }, []);

  const handleModelChange = (e: any) => {
    const newValue = e.target.value;
    setSelectedModel(newValue);
    vsCode.postMessage({
      command: "user-input",
      message: newValue,
    });
  };

  const handleCodeBuddyMode = (e: any) => {
    const newValue = e.target.value;
    setSelectedCodeBuddyMode(newValue);
    vsCode.postMessage({
      command: "user-input",
      message: newValue,
    });
  };

  const handleTextChange = (e: any) => {
    const newValue = e.target.value;
    setUserInput(newValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    if (!userInput.trim()) return;

    setMessages((previousMessages) => [
      ...(previousMessages || []),
      {
        type: "user",
        content: userInput,
        alias: "O",
      },
    ]);

    setIsBotLoading(true); // Start loading when sending message

    vsCode.postMessage({
      command: "user-input",
      message: userInput,
      tags: ["file", "index", "search"],
    });

    setUserInput("");
  };

  return (
    <div className="container">
      <div className="dropdown-container">
        <div>
          {messages?.map((msg, index) =>
            msg.type === "bot" ? (
              <BotMessage key={index} content={msg.content} />
            ) : (
              <UserMessage
                key={index}
                message={msg.content}
                alias={msg.alias}
              />
            )
          )}
          {isBotLoading && <VSCodeProgressRing />}{" "}
          {/* This doesnt work as expected */}
        </div>
      </div>
      <div className="business">
        <div className="horizontal-stack">
          <span className="currenFile">
            <small>create-singleClient.dto.ts</small>
          </span>
        </div>
        <div className="textarea-container">
          <VSCodeTextArea
            value={userInput}
            onInput={handleTextChange}
            placeholder="Ask a question or enter '/' for quick actions"
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="horizontal-stack">
          <AttachmentIcon
            onClick={() => setActiveItem("attach")}
            isActive={activeItem === "attach"}
          />
          <ModelDropdown
            value={selectedModel}
            onChange={handleModelChange}
            options={modelOptions}
            id="model"
            defaultValue="Gemini"
          />
          <ModelDropdown
            value={selectedCodeBuddyMode}
            onChange={handleCodeBuddyMode}
            options={codeBuddyMode}
            id="cBuddymode"
            defaultValue="Agent"
          />
        </div>
      </div>
    </div>
  );
};
