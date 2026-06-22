from __future__ import annotations
import json
from typing import AsyncGenerator

from openai import AsyncOpenAI

from backend.config import settings

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "ask_oracle",
            "description": (
                "Answer questions about paper content using RAG. Use this when the user "
                "wants a summary, recap, explanation, or answer drawn from paper content. "
                "Examples: 'summarize X', 'give me a recap of', 'what does the paper say about', "
                "'explain', 'what are the key findings', 'compare X and Y'."
            ),
            "parameters": {
                "type": "object",
                "properties": {"question": {"type": "string"}},
                "required": ["question"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_paper",
            "description": (
                "Return the title and metadata of papers matching a description. "
                "Use ONLY when the user is trying to identify or locate a paper by its topic "
                "without asking for its content — e.g. 'which paper covers X?', "
                "'find me the paper on Y', 'what paper did I read about Z?'. "
                "Do NOT use this for summaries, recaps, or content questions."
            ),
            "parameters": {
                "type": "object",
                "properties": {"description": {"type": "string"}},
                "required": ["description"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_paper_status",
            "description": (
                "Mark a paper as 'read' or 'toread'. Use when the user says they finished "
                "reading, have read, or want to mark a paper's status. "
                "If the user refers to 'it' or 'this paper', resolve which paper they mean "
                "from the conversation history before calling this tool."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "description": {
                        "type": "string",
                        "description": (
                            "The paper's title or a clear identifying description. "
                            "Resolve pronouns ('it', 'this') using conversation history."
                        ),
                    },
                    "status": {
                        "type": "string",
                        "enum": ["read", "toread"],
                        "description": "'read' if they have read it, 'toread' to queue it.",
                    },
                },
                "required": ["description", "status"],
            },
        },
    },
]

SYSTEM = (
    "You route user requests to exactly one tool. "
    "Use ask_oracle for questions requiring paper CONTENT: summaries, recaps, explanations, findings, comparisons. "
    "Use find_paper only to IDENTIFY or LOCATE a paper by description (not to read its content). "
    "Use set_paper_status when the user wants to mark a paper as read or to-read — "
    "resolve which paper they mean from conversation history if they use 'it' or 'this paper'. "
    "Always use a tool — never answer directly."
)


class MasterAgent:
    def __init__(self, oracle, librarian, status_agent) -> None:
        self._client  = AsyncOpenAI(api_key=settings.openai_api_key)
        self._oracle  = oracle
        self._lib     = librarian
        self._status  = status_agent

    async def run(
        self,
        message: str,
        history: list[dict] | None = None,
    ) -> AsyncGenerator[str, None]:
        messages: list[dict] = [{"role": "system", "content": SYSTEM}]
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": message})

        resp = await self._client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            tools=TOOLS,
            tool_choice="required",
            temperature=0,
        )

        choice = resp.choices[0]
        if not choice.message.tool_calls:
            yield f"data: {json.dumps({'type': 'chunk', 'text': choice.message.content or ''})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            return

        tool_call = choice.message.tool_calls[0]
        args = json.loads(tool_call.function.arguments)

        if tool_call.function.name == "ask_oracle":
            async for chunk in self._oracle.stream(args["question"]):
                yield chunk
        elif tool_call.function.name == "find_paper":
            async for chunk in self._lib.search(args["description"]):
                yield chunk
        elif tool_call.function.name == "set_paper_status":
            async for chunk in self._status.set_status(args["description"], args["status"]):
                yield chunk
        else:
            yield f"data: {json.dumps({'type': 'chunk', 'text': 'Unknown tool.'})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
