@echo off
set OPENSSL_CONF=openssl-client.conf
set CERT_DAYS=365
set CERT_NAME=client
set URN=urn:freeopcua:client

echo [req] > %OPENSSL_CONF%
echo distinguished_name = req_distinguished_name >> %OPENSSL_CONF%
echo x509_extensions = v3_req >> %OPENSSL_CONF%
echo prompt = no >> %OPENSSL_CONF%
echo. >> %OPENSSL_CONF%
echo [req_distinguished_name] >> %OPENSSL_CONF%
echo CN = FreeOPCUA Client >> %OPENSSL_CONF%
echo. >> %OPENSSL_CONF%
echo [v3_req] >> %OPENSSL_CONF%
echo subjectAltName = URI:%URN%,DNS:%COMPUTERNAME% >> %OPENSSL_CONF%
echo keyUsage = digitalSignature, nonRepudiation, keyEncipherment, dataEncipherment >> %OPENSSL_CONF%
echo extendedKeyUsage = clientAuth >> %OPENSSL_CONF%

:: Генерация PEM ключа и сертификата
openssl req -newkey rsa:2048 -nodes -keyout %CERT_NAME%_private.pem -x509 -days %CERT_DAYS% -out %CERT_NAME%_cert.pem -config %OPENSSL_CONF% -extensions v3_req

:: Конвертация в DER формат
openssl x509 -in %CERT_NAME%_cert.pem -outform der -out %CERT_NAME%.der
openssl rsa -in %CERT_NAME%_private.pem -outform der -out %CERT_NAME%_private.der

echo.
echo ✅ Сертификат и ключ успешно созданы!
echo - %CERT_NAME%.der
echo - %CERT_NAME%_private.der
echo.
pause
