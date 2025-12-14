use wasm_bindgen::prelude::*;
use openmls::prelude::*;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_basic_credential::SignatureKeyPair;
use openmls_memory_storage::MemoryStorage;
use openmls_traits::OpenMlsProvider;
// use openmls_traits::storage::OpenMlsStorage; // Not needed if we use MemoryStorage directly or find the trait later
use argon2::{
    Argon2
};
use sha2::{Sha256, Digest};
use hex;
use tls_codec::{Serialize, Deserialize};
use std::collections::HashMap;

// Explicit imports
use openmls::group::{MlsGroupCreateConfig, MlsGroupJoinConfig, StagedWelcome, GroupId};
use openmls::credentials::{Credential, CredentialType};
use openmls::extensions::Extensions;
use openmls::key_packages::{KeyPackage, KeyPackageIn, KeyPackageBundle};
use openmls::treesync::RatchetTreeIn;
use openmls_traits::storage::StorageProvider; // For writing KeyPackageBundle

use openmls::framing::{ProcessedMessageContent, MlsMessageIn, MlsMessageBodyIn};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[wasm_bindgen]
pub fn init_logging() {
    console_error_panic_hook::set_once();
    log("OpenMLS WASM initialized");
}

#[wasm_bindgen]
pub struct MlsClient {
    #[wasm_bindgen(skip)]
    pub provider: OpenMlsRustCrypto,

    #[wasm_bindgen(skip)]
    pub storage: MemoryStorage,
    
    #[wasm_bindgen(skip)]
    pub credential: Option<Credential>,
    
    #[wasm_bindgen(skip)]
    pub signature_keypair: Option<SignatureKeyPair>,
    
    #[wasm_bindgen(skip)]
    pub key_package: Option<KeyPackage>,
    
    #[wasm_bindgen(skip)]
    pub groups: HashMap<Vec<u8>, MlsGroup>,
}

#[wasm_bindgen]
impl MlsClient {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MlsClient {
        MlsClient {
            provider: OpenMlsRustCrypto::default(),
            storage: MemoryStorage::default(),
            credential: None,
            signature_keypair: None,
            key_package: None,
            groups: HashMap::new(),
        }
    }

    pub fn create_group(&mut self, group_id_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        // Use self.provider instead of creating a new one
        let provider = &self.provider;
        
        let signature_keypair = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;

        let credential = self.credential.as_ref()
            .ok_or_else(|| JsValue::from_str("No credential available"))?;

        let credential_with_key = CredentialWithKey {
            credential: credential.clone(),
            signature_key: signature_keypair.to_public_vec().into(),
        };

        let group_config = MlsGroupCreateConfig::builder()
            .wire_format_policy(WireFormatPolicy::default())
            .use_ratchet_tree_extension(true)
            .build();

        // Use new_with_group_id to ensure our external group ID matches MLS internal ID
        let group_id = GroupId::from_slice(group_id_bytes);

        let group = MlsGroup::new_with_group_id(
            provider,
            signature_keypair,
            &group_config,
            group_id,
            credential_with_key,
        ).map_err(|e| JsValue::from_str(&format!("Error creating group: {:?}", e)))?;

        // Store using the MLS group ID to ensure consistency
        let mls_group_id = group.group_id().as_slice().to_vec();
        log(&format!("[WASM] create_group: MLS group ID = {}", hex::encode(&mls_group_id)));

        self.groups.insert(mls_group_id.clone(), group);

        Ok(mls_group_id)
    }

    pub fn create_identity(&mut self, identity_name: &str) -> Result<String, JsValue> {
        let provider = &self.provider;
        let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
        
        let signature_keypair = SignatureKeyPair::new(ciphersuite.signature_algorithm())
            .map_err(|e| JsValue::from_str(&format!("Error creating signature keypair: {:?}", e)))?;

        // Create a basic credential (arguments: credential_type, identity)
        let credential = Credential::new(
            CredentialType::Basic,
            identity_name.as_bytes().to_vec(),
        );
        
        let credential_with_key = CredentialWithKey {
            credential: credential.clone(),
            signature_key: signature_keypair.to_public_vec().into(),
        };

        // Build the key package and store private part in storage
        let key_package_bundle = KeyPackage::builder()
            .key_package_extensions(Extensions::default())
            .build(
                openmls::prelude::Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
                provider,
                &signature_keypair,
                credential_with_key,
            )
            .map_err(|e| JsValue::from_str(&format!("Error creating key package: {:?}", e)))?;

        let key_package_ref = key_package_bundle.key_package();
        let hash = key_package_ref.hash_ref(provider.crypto())
             .map_err(|e| JsValue::from_str(&format!("Error hashing key package: {:?}", e)))?;
             
        let hash = key_package_ref.hash_ref(provider.crypto())
             .map_err(|e| JsValue::from_str(&format!("Error hashing key package: {:?}", e)))?;
             
        log(&format!("[WASM] Writing KeyPackage Hash: {}", hex::encode(hash.as_slice())));
        
        provider.storage().write_key_package(&hash, &key_package_bundle)
            .map_err(|e| JsValue::from_str(&format!("Error saving key package bundle: {:?}", e)))?;

        let key_package = key_package_ref.clone();

        self.credential = Some(credential);
        self.signature_keypair = Some(signature_keypair);
        self.key_package = Some(key_package);
        
        log(&format!("Identity created for: {}", identity_name));
        
        Ok("Identity created".to_string())
    }

    pub fn get_key_package_bytes(&self) -> Result<Vec<u8>, JsValue> {
        if let Some(kp) = &self.key_package {
            kp.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing key package: {:?}", e)))
        } else {
            Err(JsValue::from_str("No identity created yet"))
        }
    }

    pub fn get_credential_bytes(&self) -> Result<Vec<u8>, JsValue> {
        if let Some(c) = &self.credential {
            c.tls_serialize_detached()
                .map_err(|e| JsValue::from_str(&format!("Error serializing credential: {:?}", e)))
        } else {
            Err(JsValue::from_str("No credential available"))
        }
    }

    pub fn get_signature_keypair_bytes(&self) -> Result<Vec<u8>, JsValue> {
        if let Some(skp) = &self.signature_keypair {
            serde_json::to_vec(skp)
                .map_err(|e| JsValue::from_str(&format!("Error serializing signature keypair: {:?}", e)))
        } else {
            Err(JsValue::from_str("No signature keypair available"))
        }
    }

    pub fn get_key_package_bundle_bytes(&self) -> Result<Vec<u8>, JsValue> {
        let key_package = self.key_package.as_ref()
            .ok_or_else(|| JsValue::from_str("No identity created yet"))?;
            
        let hash = key_package.hash_ref(self.provider.crypto())
            .map_err(|e| JsValue::from_str(&format!("Error hashing key package: {:?}", e)))?;
            
        let bundle: Option<KeyPackageBundle> = self.provider.storage()
            .key_package(&hash)
            .map_err(|e| JsValue::from_str(&format!("Error reading key package bundle: {:?}", e)))?;
            
        if let Some(b) = bundle {
            serde_json::to_vec(&b)
                .map_err(|e| JsValue::from_str(&format!("Error serializing bundle: {:?}", e)))
        } else {
            Err(JsValue::from_str("Key package bundle not found in storage"))
        }
    }

    pub fn restore_identity(&mut self, credential_bytes: Vec<u8>, bundle_bytes: Vec<u8>, signature_key_bytes: Vec<u8>) -> Result<(), JsValue> {
        let mut slice = credential_bytes.as_slice();
        let credential = <Credential as Deserialize>::tls_deserialize(&mut slice)
            .map_err(|e| JsValue::from_str(&format!("Error deserializing credential: {:?}", e)))?;

        let signature_keypair: SignatureKeyPair = serde_json::from_slice(&signature_key_bytes)
            .map_err(|e| JsValue::from_str(&format!("Error deserializing signature keypair: {:?}", e)))?;

        let bundle: KeyPackageBundle = serde_json::from_slice(&bundle_bytes)
            .map_err(|e| JsValue::from_str(&format!("Error deserializing bundle: {:?}", e)))?;

        let key_package = bundle.key_package();
        let hash = key_package.hash_ref(self.provider.crypto())
             .map_err(|e| JsValue::from_str(&format!("Error hashing key package: {:?}", e)))?;

        log(&format!("[WASM] restore_identity: Writing KeyPackage Hash: {}", hex::encode(hash.as_slice())));

        self.provider.storage().write_key_package(&hash, &bundle)
            .map_err(|e| JsValue::from_str(&format!("Error saving key package bundle: {:?}", e)))?;

        self.credential = Some(credential);
        self.signature_keypair = Some(signature_keypair);
        self.key_package = Some(key_package.clone());

        Ok(())
    }

    /// Regenerate a new KeyPackage using the existing credential and signature key
    /// Per OpenMLS Book: KeyPackages are single-use and must be regenerated after being consumed
    pub fn regenerate_key_package(&mut self) -> Result<(), JsValue> {
        let provider = &self.provider;

        let signature_keypair = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;

        let credential = self.credential.as_ref()
            .ok_or_else(|| JsValue::from_str("No credential available"))?;

        let credential_with_key = CredentialWithKey {
            credential: credential.clone(),
            signature_key: signature_keypair.to_public_vec().into(),
        };

        // Build a new key package
        let key_package_bundle = KeyPackage::builder()
            .key_package_extensions(Extensions::default())
            .build(
                Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
                provider,
                signature_keypair,
                credential_with_key,
            )
            .map_err(|e| JsValue::from_str(&format!("Error creating key package: {:?}", e)))?;

        let key_package_ref = key_package_bundle.key_package();
        let hash = key_package_ref.hash_ref(provider.crypto())
             .map_err(|e| JsValue::from_str(&format!("Error hashing key package: {:?}", e)))?;

        log(&format!("[WASM] regenerate_key_package: Writing new KeyPackage Hash: {}", hex::encode(hash.as_slice())));

        provider.storage().write_key_package(&hash, &key_package_bundle)
            .map_err(|e| JsValue::from_str(&format!("Error saving key package bundle: {:?}", e)))?;

        self.key_package = Some(key_package_ref.clone());

        log("[WASM] KeyPackage regenerated successfully");

        Ok(())
    }

    // ... SOTA Security Features ...

    pub fn derive_key_argon2id(password: &str, salt: &[u8]) -> Result<Vec<u8>, JsValue> {
        let argon2 = Argon2::default();
        let mut output_key = [0u8; 32];
        argon2.hash_password_into(password.as_bytes(), salt, &mut output_key)
            .map_err(|e| JsValue::from_str(&format!("Argon2 error: {:?}", e)))?;
        Ok(output_key.to_vec())
    }

    pub fn get_identity_fingerprint(&self) -> Result<String, JsValue> {
        let credential = self.credential.as_ref()
            .ok_or_else(|| JsValue::from_str("No credential available"))?;
        
        let credential_bytes = credential.tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing credential: {:?}", e)))?;
            
        let mut hasher = Sha256::new();
        hasher.update(credential_bytes);
        let result = hasher.finalize();
        Ok(hex::encode(result))
    }

    // ... Group Management ...

    pub fn add_member(&mut self, group_id_bytes: &[u8], key_package_bytes: &[u8]) -> Result<js_sys::Array, JsValue> {
        let signer = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;
            
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;
        
        let provider = &self.provider;
        
        // Use KeyPackageIn to deserialize and convert to KeyPackage
        let key_package_in = KeyPackageIn::tls_deserialize(&mut &key_package_bytes[..])
             .map_err(|e| JsValue::from_str(&format!("Error deserializing key package: {:?}", e)))?;

        let key_package = key_package_in.validate(provider.crypto(), ProtocolVersion::Mls10)
             .map_err(|e| JsValue::from_str(&format!("Error validating key package: {:?}", e)))?;

        let (commit, welcome_msg, _group_info) = group.add_members(
            provider,
            signer,
            &[key_package],
        ).map_err(|e| JsValue::from_str(&format!("Error adding member: {:?}", e)))?;

        group.merge_pending_commit(provider)
            .map_err(|e| JsValue::from_str(&format!("Error merging commit: {:?}", e)))?;

        // Serialize as full MlsMessage (includes type tag)
        let commit_bytes = commit.tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing commit: {:?}", e)))?;

        // Serialize welcome as full MlsMessage (includes type tag for Welcome)
        let welcome_bytes = welcome_msg.tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing welcome: {:?}", e)))?;

        log(&format!("[WASM] add_member: Welcome MlsMessage serialized to {} bytes", welcome_bytes.len()));

        let array = js_sys::Array::new();
        array.push(&js_sys::Uint8Array::from(&welcome_bytes[..]));
        array.push(&js_sys::Uint8Array::from(&commit_bytes[..]));
        Ok(array)
    }

    pub fn process_welcome(&mut self, welcome_bytes: &[u8], ratchet_tree_bytes: Option<Vec<u8>>) -> Result<Vec<u8>, JsValue> {
        let provider = &self.provider;

        // First deserialize as MlsMessageIn (the full MLS message wrapper)
        let mls_message_in = MlsMessageIn::tls_deserialize(&mut &welcome_bytes[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing MLS message: {:?}", e)))?;

        // Extract the Welcome from the MLS message body
        let welcome = match mls_message_in.extract() {
            MlsMessageBodyIn::Welcome(welcome) => welcome,
            other => return Err(JsValue::from_str(&format!("Message is not a Welcome, got: {:?}", std::mem::discriminant(&other)))),
        };

        let ratchet_tree = if let Some(bytes) = ratchet_tree_bytes {
            Some(RatchetTreeIn::tls_deserialize(&mut &bytes[..])
                .map_err(|e| JsValue::from_str(&format!("Error deserializing ratchet tree: {:?}", e)))?)
        } else {
            None
        };

        let group_config = MlsGroupJoinConfig::builder()
            .wire_format_policy(WireFormatPolicy::default())
            .build();

        log(&format!("[WASM] Processing Welcome with secrets count: {}", welcome.secrets().len()));
        for (i, secret) in welcome.secrets().iter().enumerate() {
            log(&format!("[WASM] Welcome secret #{} expects KeyPackage Hash: {:?}", i, secret.new_member()));
        }

        let staged_welcome = StagedWelcome::new_from_welcome(
            provider,
            &group_config,
            welcome,
            ratchet_tree,
        ).map_err(|e| JsValue::from_str(&format!("Error creating staged welcome: {:?}", e)))?;

        let group = staged_welcome.into_group(provider)
            .map_err(|e| JsValue::from_str(&format!("Error creating group from welcome: {:?}", e)))?;

        let group_id = group.group_id().as_slice().to_vec();
        self.groups.insert(group_id.clone(), group);

        Ok(group_id)
    }

    pub fn process_commit(&mut self, group_id_bytes: &[u8], commit_bytes: &[u8]) -> Result<(), JsValue> {
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;
            
        let provider = &self.provider;
        
        let message_in = MlsMessageIn::tls_deserialize(&mut &commit_bytes[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing commit message: {:?}", e)))?;

        let protocol_message = ProtocolMessage::try_from(message_in)
            .map_err(|e| JsValue::from_str(&format!("Error converting message: {:?}", e)))?;

        let processed_message = group.process_message(
            provider,
            protocol_message,
        ).map_err(|e| JsValue::from_str(&format!("Error processing message: {:?}", e)))?;

        match processed_message.into_content() {
            ProcessedMessageContent::StagedCommitMessage(staged_commit) => {
                group.merge_staged_commit(provider, *staged_commit)
                    .map_err(|e| JsValue::from_str(&format!("Error merging staged commit: {:?}", e)))?;
            },
            _ => return Err(JsValue::from_str("Message was not a commit")),
        }

        Ok(())
    }

    pub fn encrypt_message(&mut self, group_id_bytes: &[u8], message: &[u8]) -> Result<Vec<u8>, JsValue> {
        let signer = self.signature_keypair.as_ref()
            .ok_or_else(|| JsValue::from_str("No signature keypair available"))?;
            
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;
            
        let provider = &self.provider;
        
        let mls_message = group.create_message(
            provider,
            signer,
            message,
        ).map_err(|e| JsValue::from_str(&format!("Error creating message: {:?}", e)))?;

        let message_bytes = mls_message.tls_serialize_detached()
            .map_err(|e| JsValue::from_str(&format!("Error serializing message: {:?}", e)))?;
            
        Ok(message_bytes)
    }

    pub fn decrypt_message(&mut self, group_id_bytes: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, JsValue> {
        let group = self.groups.get_mut(group_id_bytes)
            .ok_or_else(|| JsValue::from_str("Group not found"))?;
            
        let provider = &self.provider;
        
        // Deserialize directly to MlsMessageIn
        let message_in = MlsMessageIn::tls_deserialize(&mut &ciphertext[..])
            .map_err(|e| JsValue::from_str(&format!("Error deserializing message: {:?}", e)))?;

        let protocol_message = ProtocolMessage::try_from(message_in)
            .map_err(|e| JsValue::from_str(&format!("Error converting message: {:?}", e)))?;

        let processed_message = group.process_message(
            provider,
            protocol_message,
        ).map_err(|e| JsValue::from_str(&format!("Error processing message: {:?}", e)))?;

        match processed_message.into_content() {
            ProcessedMessageContent::ApplicationMessage(app_message) => {
                Ok(app_message.into_bytes())
            },
            _ => Err(JsValue::from_str("Message was not an application message")),
        }
    }
}
