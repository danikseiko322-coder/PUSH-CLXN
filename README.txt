PUSH CLXN — CARD CHECKOUT EDITION

Запуск:
1) Распакуй ZIP в отдельную папку.
2) Запусти START.bat.
3) Открой http://localhost:3000

Оплата:
- /payment.html — отдельная красивая страница оплаты.
- Цена фиксируется сервером, начиная с 120₽.
- Оплата проходит через Stripe Checkout.
- После оплаты сервер проверяет Stripe и помечает заказ paid.
- Данные банковских карт не сохраняются PUSH CLXN.

Для реальных денег:
Открой .env и добавь STRIPE_SECRET_KEY, PUBLIC_BASE_URL и при необходимости STRIPE_WEBHOOK_SECRET. Stripe должен быть активирован, а банковский счёт подключён в Dashboard.

Не вставляй номер банковской карты, CVV или PIN в код.

Подробная инструкция: SETUP_PAYMENT.txt
