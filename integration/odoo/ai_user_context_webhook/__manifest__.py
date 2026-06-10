{
    'name': 'AI User Context Webhook',
    'version': '17.0.4.0.0',
    'category': 'Technical',
    'summary': 'Injects the custom Majed «نور» chat widget + trainee context into the Odoo website',
    'description': """
Path B — Custom «نور» widget.

Injects the Majed chat widget (served by the bridge) into the Odoo website,
and exposes /ai_webhook/user_context so the widget can read trainee data
(profile, courses, progress) and pass it to the bot + Chatwoot.

The widget connects to the bridge (Railway), which talks to Botpress (bot brain)
and Chatwoot (human-agent inbox + handoff) via the API channel.

Set the bridge URL in: System Parameters → ai_webhook.bridge_url
    """,
    'author': 'Engo Software',
    'license': 'LGPL-3',
    'depends': ['base', 'website'],
    'data': [
        'data/ir_config_parameter.xml',
        'views/webchat_template.xml',
    ],
    'installable': True,
    'auto_install': False,
    'application': False,
}
