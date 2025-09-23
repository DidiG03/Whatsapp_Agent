const payload = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_ID",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "+447312706087",
              phone_number_id: "YOUR_REAL_PNID"
            },
            contacts: [{ wa_id: "447700900123" }],
            messages: [
              {
                from: "447700900123",
                id: "wamid.TEST-1699999999",
                timestamp: "1699999999",
                type: "text",
                text: { body: "hello" }
              }
            ]
          }
        }
      ]
    }
  ]
};