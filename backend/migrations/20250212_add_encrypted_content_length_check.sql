-- Add a length constraint to limit message payload size (base64 length)
ALTER TABLE messages
  ADD CONSTRAINT encrypted_content_max_len
  CHECK (char_length(encrypted_content) <= 24576);


