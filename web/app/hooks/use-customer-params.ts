"use client";

/** Shim for midday's nuqs-backed customer params hook. midday uses it to drive
 *  its detail/create sheets from the URL; here it exposes the same shape so
 *  midday's components (empty-states, columns) compile and run unchanged.
 *  Wire real sheet routing here when those screens are ported. */
import { useCallback, useState } from "react";

export type CustomerParams = {
  customerId?: string | null;
  createCustomer?: boolean | null;
  details?: boolean | null;
};

export function useCustomerParams() {
  const [params, setState] = useState<CustomerParams>({});

  const setParams = useCallback((next: CustomerParams | null) => {
    setState(next ?? {});
  }, []);

  return { params, setParams };
}
