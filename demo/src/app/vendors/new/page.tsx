import { VendorForm } from '../../../components/VendorForm';

/** /vendors/new — the page a user is on when they hit the duplicate-email bug. */
export default function NewVendorPage() {
  return (
    <main>
      <h1>Add a vendor</h1>
      <VendorForm />
    </main>
  );
}
