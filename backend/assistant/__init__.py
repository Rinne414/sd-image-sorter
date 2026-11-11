"""The built-in assistant: a chat panel that works the program for the user.

It talks to a chat model the user chose (their own key, or a model server on
this computer) and gives it a small set of tools over the program's own REST
API, the same surface the MCP server uses. Reading runs at once; anything that
changes the library waits for the user's confirmation; files are never moved
or deleted by it.

Modules:

* ``settings``  which model service to use and how much the assistant may do
* ``tools``     the tool table: one class per tool (read / show / change)
* ``llm``       one streamed chat-completions call with tool calls
* ``runs``      a run of the loop: events, confirmation, stop
"""
