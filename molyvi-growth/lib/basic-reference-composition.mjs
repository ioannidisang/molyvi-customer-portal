// Deliberately narrow LOCAL facade. Capability minting and the shared private
// assembler live together so there is no public, unchecked metadata resolver.
// Legacy preparation/export remains a separate byte-buffer-only contract.
export {
  prepareStoredBasicReferenceComposition,
  isBasicReferenceComposition,
  verifyBasicReferenceComposition,
} from './basic-store-package.mjs';
