from googlechatai import GoogleChatAI


def build_chat() -> GoogleChatAI:
    chat = GoogleChatAI(
        app_user={
            "name": __import__("os").environ.get(
                "GOOGLE_CHAT_APP_USER",
                "users/app",
            )
        }
    )

    @chat.on_mention
    def handle_mention(ctx):
        message = ctx.current_message or {}
        prompt = (
            message.get("argumentText")
            or message.get("plainTextForModel")
            or "your message"
        )
        return ctx.reply.text(f"You said: {prompt}")

    @chat.on_message
    def handle_message(ctx):
        message = ctx.current_message or {}
        return ctx.reply.text(
            f"Received: {message.get('plainTextForModel') or ctx.event['kind']}"
        )

    return chat


chat = build_chat()
